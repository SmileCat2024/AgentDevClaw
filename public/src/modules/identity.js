/**
 * identity.js — 会话 / 运行身份解析域（P4 T1：从 app-core 抽出的第二族）。
 *
 * 原先住在 app-core.js 的 classic 顶层（纯函数 + 一个 viewer 侧会话绑定 Map）。
 * 这里仍是同一份实现，只是 owner 变成模块相：
 *
 *   - 全部函数按命名导出提供给已迁消费方（sidebar-render / session-mutation /
 *     workspace-actions / thread-store / auto-title / ph-* / slash-* 等）；
 *   - 仍有 classic 消费方的键经 KernelState 桥键（domain `identity`）暴露：
 *     app-core 自身的 getRuntimeContextKey / getAgentRuntimeId 内部调用、
 *     app-main（顶栏 / runtime-switch 宿主面）、desktop-notify。逐键清单与
 *     注销条件见文件末尾；
 *   - 对外部状态的读取一律走 window 上的桥键 / classic 函数（晚绑定，调用时点
 *     取值）：currentRuntimeAgentId、focusedAgentId、allAgents、getCurrentAgentRecord、
 *     RemoteConnections.getEntryHostAgentId。因此本模块求值时不依赖任何其它
 *     模块，装载序无关。
 *
 * 语义边界（沿用 app-core 原注释）：agentId 是稳定的逻辑 Agent / 工作空间身份；
 * sessionId 是持久化的对话身份；runtimeId 是单个 ViewerWorker 实例；parentId 只
 * 表达 child-runtime → host 关系。focusedAgentId 是页面展示态，不参与推导；
 * 已停止的 runtime 解析为 null，身份不按焦点 / 名字 / PID / 列表位置猜测。
 */

/** app-core 的宿主记录读取器（classic，经 window 晚绑定）。 */
function currentAgentRecord() {
  return typeof window.getCurrentAgentRecord === 'function' ? window.getCurrentAgentRecord() : null;
}

/** 跨前端模块共享的纯身份规范化函数（原 app-core 顶部声明）。 */
export function normalizeAgentIdentity(value) {
  return String(value || '').trim();
}

function normalizeResourceIdentity(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function hasIdentityAlias(record, aliases) {
  return !!(record && typeof record === 'object' && !Array.isArray(record)
    && aliases.some((key) => record[key] !== undefined && record[key] !== null));
}

function resolveIdentityAliases(record, aliases) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const values = aliases
    .map((key) => normalizeResourceIdentity(record[key]))
    .filter(Boolean);
  if (new Set(values).size > 1) return null;
  return values[0] || null;
}

export function getParentAgentId(record) {
  return resolveIdentityAliases(record, ['parentId', 'parent_id']);
}

export function getLogicalAgentId(record) {
  if (typeof record === 'string' || typeof record === 'number') {
    return normalizeResourceIdentity(record) || null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const explicitAgentId = resolveIdentityAliases(record, ['agentId', 'logicalAgentId']);
  if (hasIdentityAlias(record, ['agentId', 'logicalAgentId'])) {
    return explicitAgentId;
  }
  const parentId = getParentAgentId(record);
  if (parentId) return parentId;
  // A host record owns its own logical identity. A child without parentId is
  // intentionally unresolved rather than guessed from its display fields.
  if (record.source === 'prebuilt' || record.source === 'host' || record.source === 'workspace') {
    return normalizeResourceIdentity(record.id) || null;
  }
  if (!record.source && !hasIdentityAlias(record, ['runtimeId', 'runtime_session_id', 'runtimeSessionId'])) {
    return normalizeResourceIdentity(record.id) || null;
  }
  return null;
}

export function getRuntimeId(record) {
  if (typeof record === 'string' || typeof record === 'number') {
    return normalizeResourceIdentity(record) || null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const explicitRuntimeId = resolveIdentityAliases(record, ['runtimeId', 'runtime_session_id', 'runtimeSessionId']);
  if (hasIdentityAlias(record, ['runtimeId', 'runtime_session_id', 'runtimeSessionId'])) {
    return explicitRuntimeId;
  }
  // Child/external records use their own record id as the runtime identity.
  // A host record with no live runtime has no runtimeId; parentId is never a
  // substitute for a missing runtime.
  if (record.source === 'child' || record.source === 'external' || getParentAgentId(record)) {
    return normalizeResourceIdentity(record.id) || null;
  }
  return null;
}

/**
 * 控制类请求（tool_state / swap 系）的宿主身份收敛点。本地会话取 allAgents
 * 记录的逻辑 id；远程会话不在 allAgents（ADR-0010 统一投影），宿主身份取自
 * 远程目录条目，避免请求体缺 agentId 被服务端 400 拒绝。
 */
export function getCurrentControlAgentId() {
  const record = currentAgentRecord();
  const logical = getLogicalAgentId(record);
  if (logical) return logical;
  if (typeof window !== 'undefined' && window.RemoteConnections?.getEntryHostAgentId) {
    const runtimeRef = typeof window.currentRuntimeAgentId !== 'undefined' ? window.currentRuntimeAgentId : '';
    if (runtimeRef) return window.RemoteConnections.getEntryHostAgentId(runtimeRef);
  }
  return null;
}

export function getActiveSessionId(record = currentAgentRecord()) {
  // workspace_sessions.activeSessionId is the current canonical nested field;
  // the top-level fields are legacy/API aliases and are only consulted when
  // the canonical field is absent. This makes stale legacy data deterministic.
  const hasNestedSession = hasIdentityAlias(record?.workspace_sessions, ['sessionId', 'activeSessionId']);
  const nestedSessionId = resolveIdentityAliases(record?.workspace_sessions, ['sessionId', 'activeSessionId']);
  if (hasNestedSession) return nestedSessionId;
  if (hasIdentityAlias(record, ['sessionId', 'active_workspace_session_id'])) {
    return resolveIdentityAliases(record, ['sessionId', 'active_workspace_session_id']);
  }
  return null;
}

export function getAgentRuntimeId(agent) {
  return getRuntimeId(agent) || '';
}

export function buildLocalResourceRef(input) {
  const record = input && typeof input === 'object' ? input : {};
  return {
    scope: 'local',
    agentId: getLogicalAgentId(record),
    parentId: getParentAgentId(record),
    sessionId: getActiveSessionId(record),
    runtimeId: getRuntimeId(record),
  };
}

export function getActiveWorkspaceSessionId(agent = currentAgentRecord()) {
  return getActiveSessionId(agent) || '';
}

// ── Viewer-local session binding ────────────────────────────────────────────
// 会话身份的 viewer 侧真相：用户主动切换时冻结的 runtimeId → sessionId 绑定。
// Server 端 host 级 activeSessionId 会被外部入口（IM 转接 / CLI / 调度 /
// 其他标签页的 create+activate）改写；若 getRuntimeContextKey 被动跟随
// allAgents 里的该值派生，正在查看的会话的草稿 key / 录音归属 / 输入签名
// 会在用户毫无操作时整体漂移（输入面重建、录音被取消、草稿写错槽）。
// 绑定只在用户主动切换（switchAgent / 会话打开与创建）时写入。
const viewerSessionBindings = new Map();

export function setViewerSessionBinding(runtimeId, sessionId) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId) return;
  const normalizedSessionId = String(sessionId || '').trim();
  if (normalizedSessionId) {
    viewerSessionBindings.set(normalizedRuntimeId, normalizedSessionId);
  } else {
    viewerSessionBindings.delete(normalizedRuntimeId);
  }
}

export function getViewerSessionBinding(runtimeId) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId) return '';
  return String(viewerSessionBindings.get(normalizedRuntimeId) || '').trim();
}

// 从 allAgents 派生 runtime 当前关联的会话（server 侧视角，可被外部入口改写）。
export function _deriveRuntimeSessionIdFromAgents(runtimeId) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  const agents = window.allAgents;
  if (!normalizedRuntimeId || !Array.isArray(agents)) return '';
  const runtimeRecord = agents.find((item) => {
    const itemId = String(item?.id || '').trim();
    const itemRuntimeId = String(item?.runtime_session_id || item?.runtimeSessionId || '').trim();
    return itemId === normalizedRuntimeId || itemRuntimeId === normalizedRuntimeId;
  });
  return String(runtimeRecord?.active_workspace_session_id || '').trim();
}

export function getRuntimeWorkspaceSessionId(runtimeId) {
  // Viewer 绑定优先：它代表用户正在查看的会话。仅在尚未建立绑定
  // （初始恢复、未经 switchAgent 的路径）时回退到 server 派生值。
  const viewerSessionId = getViewerSessionBinding(runtimeId);
  if (viewerSessionId) return viewerSessionId;
  return _deriveRuntimeSessionIdFromAgents(runtimeId);
}

export function getRuntimeContextKey(runtimeId = window.currentRuntimeAgentId, agent = currentAgentRecord()) {
  const normalizedRuntimeId = String(runtimeId || '').trim();
  if (!normalizedRuntimeId) return null;
  const hostId = String(agent?.parent_id || agent?.id || window.focusedAgentId || '').trim();
  const sessionId = getRuntimeWorkspaceSessionId(normalizedRuntimeId) || getActiveWorkspaceSessionId(agent);
  if (hostId && sessionId) {
    return `host:${hostId}|session:${sessionId}`;
  }
  return `runtime:${normalizedRuntimeId}`;
}

// ── classic 兼容桥（仍有 window 访问面的键）────────────────────────────────
// 逐键消费面（标注面形态：`裸` = classic 裸标识符经访问器解析；`window.` = 已迁 ESM
// 但仍显式读 window 面）与注销条件：
//   normalizeAgentIdentity        ← 裸 app-main / desktop-notify；window. sidebar-render
//                                    （侧栏投影）与 runtime-status（call 状态）
//   getLogicalAgentId             ← 裸 app-main；window. sidebar-render
//   getParentAgentId              ← 裸 app-main；window. sidebar-render
//   getRuntimeId                  ← 裸 app-main；window. sidebar-render
//   getActiveSessionId            ← window. sidebar-render（子会话绑定）
//   getAgentRuntimeId             ← 裸 app-main；window. app-core（isUiOnlyAgentId /
//                                    getRuntimeRecord / findAgentByIdentity）与 sidebar-render
//   getRuntimeWorkspaceSessionId  ← 裸 app-main（顶栏标题的会话解析，带 typeof 守卫）
//   getRuntimeContextKey          ← 裸 app-main；window. app-core（打断目标缓存 /
//                                    collapse 上下文 / runtime view cache）、app-ui、input-render
//   setViewerSessionBinding       ← 裸 app-main（宿主面 bindSession）
//   _deriveRuntimeSessionIdFromAgents ← 裸 app-main（宿主面 deriveSession）
// 注销条件：classic 两件（app-main / desktop-notify）改具名 import，**且**已迁却仍读
// window 面的四件（sidebar-render / runtime-status / app-ui / input-render，本轮禁区）
// 收敛为具名 import 后，逐键删除 defineKey 与 `delete window.<key>`。
// getCurrentControlAgentId / getActiveWorkspaceSessionId / buildLocalResourceRef /
// 私有别名解析不进桥（消费方全是 ESM 具名 import 或测试）。
const bridgeState = {
  normalizeAgentIdentity,
  getLogicalAgentId,
  getParentAgentId,
  getRuntimeId,
  getActiveSessionId,
  getAgentRuntimeId,
  getRuntimeWorkspaceSessionId,
  getRuntimeContextKey,
  setViewerSessionBinding,
  _deriveRuntimeSessionIdFromAgents,
};
// 逐键注册（不用循环压成一个调用点：桥债口径按调用点数静态统计，循环会让
// 键数增长在台账里不可见）。
window.KernelState.defineKey('identity', 'normalizeAgentIdentity', bridgeState.normalizeAgentIdentity);
window.KernelState.defineKey('identity', 'getLogicalAgentId', bridgeState.getLogicalAgentId);
window.KernelState.defineKey('identity', 'getParentAgentId', bridgeState.getParentAgentId);
window.KernelState.defineKey('identity', 'getRuntimeId', bridgeState.getRuntimeId);
window.KernelState.defineKey('identity', 'getActiveSessionId', bridgeState.getActiveSessionId);
window.KernelState.defineKey('identity', 'getAgentRuntimeId', bridgeState.getAgentRuntimeId);
window.KernelState.defineKey('identity', 'getRuntimeWorkspaceSessionId', bridgeState.getRuntimeWorkspaceSessionId);
window.KernelState.defineKey('identity', 'getRuntimeContextKey', bridgeState.getRuntimeContextKey);
window.KernelState.defineKey('identity', 'setViewerSessionBinding', bridgeState.setViewerSessionBinding);
window.KernelState.defineKey('identity', '_deriveRuntimeSessionIdFromAgents', bridgeState._deriveRuntimeSessionIdFromAgents);
window.KernelState.claim('identity', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});
