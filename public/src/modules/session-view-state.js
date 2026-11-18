/**
 * session-view-state.js — selected runtime view ownership boundary.
 *
 * Async producers may read the same runtime at different moments. They must
 * capture a token before starting I/O and submit synchronous state/UI changes
 * through commitSessionViewPatch(). A runtime id alone is insufficient because
 * the user can leave and re-enter the same runtime while an older request is
 * still in flight.
 *
 * This module owns commit eligibility and model-state ordering. The poll timer
 * and in-flight promises remain resources owned by the poll coordinator.
 *
 * `sessionMeta` carries the selected session's rich metadata (session id,
 * type, timestamps, working directory, message count). Volatile display
 * fields (title, model name, live usage) deliberately stay out: they
 * resolve through live sources (catalog accessor / overview snapshot) so
 * renames and model swaps surface without waiting for a detail reload.
 * It is written as a whole replacement snapshot by the data-load / switch
 * paths and is read-only for consumers.
 *
 * ── P4 T2：classic → ESM（本批）────────────────────────────────────────────
 *
 * 状态归属（迁移前是 classic 顶层 `let` / `window` 访问器双读）：
 *   - `_sessionMeta` / `_sessionViewIdentity` / `_sessionViewGeneration` /
 *     `_sessionViewInputRequestsRevision` / `_sessionViewMessagesRevision` /
 *     `_sessionViewModelRuntimeId` → owner 是 session-view-identity-state（P2），
 *     本文件 import 活绑定 + setter 读写；
 *   - `currentMessages` / `currentInputRequests` / `toolRenderConfigs` /
 *     `TOOL_NAMES` / `currentHookInspector` / `currentOverviewSnapshot` /
 *     `currentTodoPlan` → owner 是 session-view-storage（P2），同上；
 *   - 两个 owner 域的 `defineKey` 注册点原本不同：storage 族 10 条在 app-core
 *     （仍 classic，不动），identity 族 6 条就在本文件（classic 相注册、owner
 *     claim 吸收）。identity 族的唯一生产消费方是 session-view-commit-host（已改
 *     具名 import），其余只剩测试表达式 → 那 6 条注册随本批注销，初值改为本文件
 *     求值时写进 owner，测试改读模块导出（桥债注册键净下降 6）。
 *
 * 桥键（`session-view-state` 域）：本文件对外 API 仍有未迁移消费方 ——
 *   classic：app-core / app-ui / app-main（首屏之外的同步调用点）；
 *   已迁 ESM 但按桥接期语义 `window.X` 晚绑定：runtime-status / sse-client /
 *   persistent-input / input-actions / thread-store(-domain) / session-readonly-view /
 *   generative-ui-panel / agent-data-loader / rollback-dialog-runtime /
 *   input-model-switcher / workspace-agents / chat-context-bar / tool-progress /
 *   ph-search-locate / panel-plugins/git 等。
 *   注销条件：上述消费方逐个改具名 import 后删对应 defineKey（T5 清零批次）；
 *   `test/kernel-bridge-debt-gate.test.js` 的注册/认领计数是唯一口径。
 *
 * 求值面决策（为什么不 import overview-data / todo-plan / input-render / app-main）：
 * 本文件由 kernel-entry 的第一条 import（session-view-commit-host）带入，处于整张
 * 模块图的最前段。把上述模块拉进静态图会把 debug 面板（overview-data →
 * p2-bootstrap-debug-panel）、计划面板、输入面渲染域与首屏 classic 面整体提前求值，
 * 与 runtime-status 头注记录的是同一条风险。这些键保持 `window.X` 晚绑定
 * （`getEmptyOverviewSnapshot` / `setCurrentHookInspector` / `setCurrentOverviewSnapshot`
 * / `setCurrentTodoPlan` / `getEmptyTodoPlan` / `notifyInputSurfaceChanged`），
 * 收敛（改具名 import + 注销桥键）留给 T5 清零批次。
 *
 * 其余外来键：`currentRuntimeAgentId` / `_switchEpoch`（orchestration 域）、
 * `focusedAgentId`（agent-store 域）、`currentRuntimeConnected`（runtime-status 域）
 * 与 `getCurrentHostAgentRecord`（classic app-main）一律 `window.X` 晚绑定——
 * 与迁移前裸标识符解析到 window 访问器的语义逐字一致（测试夹具也按 window 面
 * 播种这些值），改 import 会把夹具的 window 写入与模块活绑定分叉成两份状态。
 */

import {
  currentMessages,
  currentInputRequests,
  toolRenderConfigs,
  TOOL_NAMES,
  currentHookInspector,
  currentOverviewSnapshot,
  currentTodoPlan,
  setCurrentMessages,
  setCurrentInputRequests,
  setToolRenderConfigs,
  setToolNames,
} from './session-view-storage.js';
import {
  _sessionMeta,
  _sessionViewIdentity,
  _sessionViewGeneration,
  _sessionViewInputRequestsRevision,
  _sessionViewMessagesRevision,
  _sessionViewModelRuntimeId,
  setSessionMeta,
  setSessionViewIdentity,
  setSessionViewGeneration,
  setSessionViewInputRequestsRevision,
  setSessionViewMessagesRevision,
  setSessionViewModelRuntimeId,
} from './session-view-identity-state.js';

const EMPTY_SESSION_META = Object.freeze({
  sessionId: '',
  sessionType: '',
  workspaceAgentId: '',
  createdAt: '',
  updatedAt: '',
  openDirectory: '',
  messageCount: 0,
});

// identity 域的初值由本文件初始化进 owner：迁移前它们是同一批 `defineKey` 的
// initialValue（claim 时被吸收），现在那 6 条注册已注销，owner 侧没有别的初值来源。
// 初值逐项沿用迁移前的 defineKey 参数（EMPTY_SESSION_META / null / 0 / 0 / 0 / ''）：
//   - `getCurrentSessionViewIdentity` / `applySessionViewPatch` 在首次写入前就读
//     `_sessionMeta.sessionId`；
//   - 代次与两个 revision 必须是数字：undefined + 1 会变 NaN，而 token 校验用
//     `!==` 比较，NaN 会让**每一次**提交都判为过期（静默拒绝全部响应）。
// owner 域在本次求值前不可能持有旧值（除本文件没有任何写入方，访问器也已不存在），
// 因此这里是初始化而不是覆盖。
setSessionMeta(EMPTY_SESSION_META);
setSessionViewIdentity(null);
setSessionViewGeneration(0);
setSessionViewInputRequestsRevision(0);
setSessionViewMessagesRevision(0);
setSessionViewModelRuntimeId('');

function normalizeSessionMetaField(value) {
  return String(value ?? '').trim();
}

function normalizeSessionMetaCount(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizeSessionMeta(value) {
  if (!value || typeof value !== 'object') {
    return EMPTY_SESSION_META;
  }
  return Object.freeze({
    sessionId: normalizeSessionMetaField(value.sessionId),
    sessionType: normalizeSessionMetaField(value.sessionType),
    workspaceAgentId: normalizeSessionMetaField(value.workspaceAgentId),
    createdAt: normalizeSessionMetaField(value.createdAt),
    updatedAt: normalizeSessionMetaField(value.updatedAt),
    openDirectory: normalizeSessionMetaField(value.openDirectory),
    messageCount: normalizeSessionMetaCount(value.messageCount),
  });
}

export function normalizeSessionViewIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const agentId = String(value.agentId || '').trim();
  const sessionId = String(value.sessionId || '').trim();
  return agentId ? Object.freeze({ agentId, sessionId }) : null;
}

// 生产侧所有 runtimeId 归一化都在本文件内完成（无跨文件消费方）：命名导出、
// 不上桥（与 runtime-status 的「仅测试消费 helper」同口径）。
export function normalizeSessionViewRuntimeId(value) {
  return String(value || '').trim();
}

// 回执与 Overview 使用同一组模型字段；缺席值显式清空，不拼接旧模型参数。
export function normalizeSessionModelState(snapshot) {
  return {
    modelRevision: Number.isSafeInteger(snapshot?.modelRevision) && snapshot.modelRevision >= 0 ? snapshot.modelRevision : null,
    modelName: typeof snapshot?.modelName === 'string' ? snapshot.modelName : '',
    presetName: typeof snapshot?.presetName === 'string' ? snapshot.presetName : '',
    thinkingEffort: typeof snapshot?.thinkingEffort === 'string' ? snapshot.thinkingEffort : null,
    contextLength: typeof snapshot?.contextLength === 'number' && snapshot.contextLength > 0 ? snapshot.contextLength : null,
    compressRatio: typeof snapshot?.compressRatio === 'number' && snapshot.compressRatio > 0 ? snapshot.compressRatio : null,
    provider: typeof snapshot?.provider === 'string' ? snapshot.provider : '',
  };
}

function readCurrentHostAgentId() {
  const host = typeof window.getCurrentHostAgentRecord === 'function'
    ? window.getCurrentHostAgentRecord()   // 桥接期：定义于 app-main（首屏编排域收敛时移除）
    : null;
  return String(host?.id || window.focusedAgentId || '').trim();
}

export function getCurrentSessionViewIdentity() {
  const explicit = normalizeSessionViewIdentity(_sessionViewIdentity);
  if (explicit) return explicit;
  return normalizeSessionViewIdentity({ agentId: readCurrentHostAgentId(), sessionId: _sessionMeta.sessionId });
}

export function captureSessionViewToken(runtimeId = window.currentRuntimeAgentId, identity = getCurrentSessionViewIdentity()) {
  return Object.freeze({
    runtimeId: normalizeSessionViewRuntimeId(runtimeId),
    identity: normalizeSessionViewIdentity(identity),
    switchEpoch: window._switchEpoch,
    generation: _sessionViewGeneration,
    inputRequestsRevision: _sessionViewInputRequestsRevision,
    messagesRevision: _sessionViewMessagesRevision,
  });
}

/**
 * Capture the selected runtime's logical view for one synchronous render.
 *
 * The envelope is frozen and identity-bound. Nested values are replacement
 * snapshots owned by this module and are read-only by contract: consumers may
 * retain or inspect them, but must submit changes through apply/commit patch.
 * Keeping the envelope shallow avoids cloning large transcripts on every
 * render while still preventing consumers from replacing snapshot fields.
 */
export function readCurrentSessionViewState() {
  return Object.freeze({
    runtimeId: normalizeSessionViewRuntimeId(window.currentRuntimeAgentId),
    identity: getCurrentSessionViewIdentity(),
    switchEpoch: window._switchEpoch,
    messages: currentMessages,
    inputRequests: currentInputRequests,
    toolRenderConfigs,
    toolNames: TOOL_NAMES,
    hookInspector: currentHookInspector,
    overview: currentOverviewSnapshot,
    todoPlan: currentTodoPlan,
    sessionMeta: _sessionMeta,
    connected: window.currentRuntimeConnected,
  });
}

export function applySessionViewPatch(patch) {
  if (!patch || typeof patch !== 'object') {
    throw new TypeError('session view patch must be an object');
  }
  const identityBefore = getCurrentSessionViewIdentity();
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  const nextIdentity = has('identity')
    ? normalizeSessionViewIdentity(patch.identity)
    : null;
  const identityChanged = has('identity') && (() => {
    const current = getCurrentSessionViewIdentity();
    return current?.agentId !== nextIdentity?.agentId || current?.sessionId !== nextIdentity?.sessionId;
  })();
  if (identityChanged) {
    patch = {
      ...patch,
      messages: [],
      inputRequests: [],
      toolRenderConfigs: {},
      toolNames: {},
      hookInspector: { lifecycleOrder: [], features: [], hooks: [] },
      overview: typeof window.getEmptyOverviewSnapshot === 'function' ? window.getEmptyOverviewSnapshot() : {},
      todoPlan: typeof window.getEmptyTodoPlan === 'function' ? window.getEmptyTodoPlan() : {},
      sessionMeta: null,
      connected: false,
    };
  }
  if (has('identity')) {
    setSessionViewIdentity(normalizeSessionViewIdentity(patch.identity));
  }
  if (has('messages')) {
    const messages = Array.isArray(patch.messages) ? patch.messages : [];
    // 未变化的 probe 会复用原数组，不是一次新的消息观察。
    if (messages !== currentMessages) setSessionViewMessagesRevision(_sessionViewMessagesRevision + 1);
    setCurrentMessages(messages);
  }
  if (has('inputRequests')) {
    // 相同内容的快照也是新观察，必须阻止更早的响应重新写回旧 lease。
    setSessionViewInputRequestsRevision(_sessionViewInputRequestsRevision + 1);
    const requests = Array.isArray(patch.inputRequests) ? patch.inputRequests : [];
    setCurrentInputRequests(requests);
    window.lastInputRequests = requests;
    // 工单 037：inputRequests 的规范写入点即输入面的唯一变更声明通道——
    // 写入本身就触发输入面渲染，调用方不再手动 reset 签名 + 调 render。
    // 渲染器未加载时（部分测试沙箱 / 早期启动）声明为 no-op。
    if (typeof window.notifyInputSurfaceChanged === 'function') {
      window.notifyInputSurfaceChanged(requests);
    }
  }
  if (has('toolRenderConfigs')) {
    setToolRenderConfigs(patch.toolRenderConfigs && typeof patch.toolRenderConfigs === 'object'
      ? patch.toolRenderConfigs
      : {});
  }
  if (has('toolNames')) {
    setToolNames(patch.toolNames && typeof patch.toolNames === 'object'
      ? patch.toolNames
      : {});
  }
  if (has('hookInspector')) {
    // 桥接期：定义于 overview-data（去重签名与 debug 面板选中态在同一实现里）
    window.setCurrentHookInspector(patch.hookInspector);
  }
  if (has('overview') || has('model')) {
    const runtimeId = normalizeSessionViewRuntimeId(window.currentRuntimeAgentId);
    // 桥接期：定义于 overview-data
    window.setCurrentOverviewSnapshot({
      ...(has('overview') ? patch.overview : currentOverviewSnapshot),
      ...normalizeSessionModelState(has('model') ? patch.model : patch.overview),
    });
    setSessionViewModelRuntimeId(runtimeId);
  }
  if (has('todoPlan')) {
    // 桥接期：定义于 todo-plan（计划去重签名与 badge 在同一实现里）
    window.setCurrentTodoPlan(patch.todoPlan);
  }
  if (has('sessionMeta')) {
    setSessionMeta(normalizeSessionMeta(patch.sessionMeta));
  }
  // 未显式携带 identity 的写入路径（数据加载 / 缓存恢复）由 sessionMeta 推导
  // 会话身份：sessionId 是元数据的一部分，身份与数据必须同源落地，避免
  // loadAgentData 先后两次 patch 之间身份与内容错位。
  // 空元数据不携带身份事实：缓存恢复等路径可能带有 sessionId 为空的元数据
  // 快照，此时不得把已有的视图身份改写成空身份——否则切回会话后界面内容
  // 已恢复，但输入面/模型切换读到的视图会话为空，表现为「当前会话不支持
  // 模型切换」。身份更新只在元数据确实携带 sessionId 时发生。
  if (!has('identity') && has('sessionMeta')) {
    const sessionId = String(_sessionMeta.sessionId || '').trim();
    if (sessionId) {
      setSessionViewIdentity(normalizeSessionViewIdentity({ agentId: readCurrentHostAgentId(), sessionId }));
    }
  }
  if (has('connected')) {
    // runtime-status 域的桥键（owner p2-w2-2-runtime-status-owner，本文件只写）。
    window.currentRuntimeConnected = patch.connected !== false;
  }
  // 生效身份发生变化（含 null→有值）→ 推进代次，作废全部在途 token。
  const identityAfter = getCurrentSessionViewIdentity();
  const identityFieldsChanged = identityBefore?.agentId !== identityAfter?.agentId
    || identityBefore?.sessionId !== identityAfter?.sessionId;
  if (identityFieldsChanged || (!identityBefore && identityAfter)) {
    setSessionViewGeneration(_sessionViewGeneration + 1);
  }
}

/**
 * Commit host for the ESM policy module（session-view-commit-host）。
 * session-view-commit-host 在 kernel-entry 的首条 import 上求值，必须具名 import
 * 本函数——经 window 晚绑定会在该时点拿到 undefined（本文件同样由它带入）。
 */
export function createSessionViewCommitHost() {
  return {
    identity: () => getCurrentSessionViewIdentity(),
    read: () => readCurrentSessionViewState(),
    apply: (patch) => applySessionViewPatch(patch),
    normalizeModel: (value) => normalizeSessionModelState(value),
  };
}

// ── 兼容桥（KernelState，session-view-state 域）──────────────────────────────
// 消费方清单与注销条件见文件头注。逐键注册后一次性 claim：本域所有键的 owner
// 就是本模块，claim 让访问器直接转发到下面的 compatibility 表（与 overview-data /
// todo-plan 同型），不再经过哑存储。
const compatibility = {
  normalizeSessionViewIdentity,
  normalizeSessionModelState,
  getCurrentSessionViewIdentity,
  captureSessionViewToken,
  readCurrentSessionViewState,
  applySessionViewPatch,
};
// 逐键显式注册（不用循环注册）：桥债门禁按调用点静态计数，循环会把 6 个键压成
// 1 个调用点，让 registeredKeys 口径失真。
window.KernelState.defineKey('session-view-state', 'normalizeSessionViewIdentity', normalizeSessionViewIdentity);
window.KernelState.defineKey('session-view-state', 'normalizeSessionModelState', normalizeSessionModelState);
window.KernelState.defineKey('session-view-state', 'getCurrentSessionViewIdentity', getCurrentSessionViewIdentity);
window.KernelState.defineKey('session-view-state', 'captureSessionViewToken', captureSessionViewToken);
window.KernelState.defineKey('session-view-state', 'readCurrentSessionViewState', readCurrentSessionViewState);
window.KernelState.defineKey('session-view-state', 'applySessionViewPatch', applySessionViewPatch);
window.KernelState.claim('session-view-state', {
  get: (key) => compatibility[key],
  set: (key, value) => { compatibility[key] = value; },
});
