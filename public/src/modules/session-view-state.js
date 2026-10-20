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
 */

function normalizeSessionViewIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const agentId = String(value.agentId || '').trim();
  const sessionId = String(value.sessionId || '').trim();
  return agentId ? Object.freeze({ agentId, sessionId }) : null;
}

function normalizeSessionViewRuntimeId(value) {
  return String(value || '').trim();
}

const EMPTY_SESSION_META = Object.freeze({
  sessionId: '',
  sessionType: '',
  createdAt: '',
  updatedAt: '',
  openDirectory: '',
  messageCount: 0,
});

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
    createdAt: normalizeSessionMetaField(value.createdAt),
    updatedAt: normalizeSessionMetaField(value.updatedAt),
    openDirectory: normalizeSessionMetaField(value.openDirectory),
    messageCount: normalizeSessionMetaCount(value.messageCount),
  });
}

// 回执与 Overview 使用同一组模型字段；缺席值显式清空，不拼接旧模型参数。
function normalizeSessionModelState(snapshot) {
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

let _sessionMeta = EMPTY_SESSION_META;
let _sessionViewIdentity = null;
// 身份代次：每次生效身份变化（显式 identity 或 sessionMeta 推导）推进。
// 仅比较 runtimeId + epoch 无法拒绝「同 runtime 离开又回到同一 Session」
// 时残留的旧 token（A→B→A 回访，epoch 未变）：旧生产者携带过期数据仍能
// 通过校验。代次让任何身份变化作废全部在途 token。
let _sessionViewGeneration = 0;
// 独立于视图身份：输入请求被事件/本地操作写入后，在途快照不得覆盖它。
let _sessionViewInputRequestsRevision = 0;
let _sessionViewModelRuntimeId = '';

function getCurrentSessionViewIdentity() {
  const explicit = normalizeSessionViewIdentity(_sessionViewIdentity);
  if (explicit) return explicit;
  const host = typeof getCurrentHostAgentRecord === 'function'
    ? getCurrentHostAgentRecord()
    : null;
  const agentId = String(host?.id || (typeof focusedAgentId !== 'undefined' ? focusedAgentId : '') || '').trim();
  return normalizeSessionViewIdentity({ agentId, sessionId: _sessionMeta.sessionId });
}

function captureSessionViewToken(runtimeId = currentRuntimeAgentId, identity = getCurrentSessionViewIdentity()) {
  return Object.freeze({
    runtimeId: normalizeSessionViewRuntimeId(runtimeId),
    identity: normalizeSessionViewIdentity(identity),
    switchEpoch: _switchEpoch,
    generation: _sessionViewGeneration,
    inputRequestsRevision: _sessionViewInputRequestsRevision,
  });
}

function isSessionViewInputRequestsCurrent(token) {
  return token?.inputRequestsRevision === _sessionViewInputRequestsRevision;
}

function isSessionViewTokenCurrent(token) {
  if (!token || _switchEpoch !== token.switchEpoch) return false;
  // 身份代次守卫：代次不匹配 = 捕获后发生过任何身份变化（含离开又回到
  // 相同身份的回访），token 一律过期。
  if (token.generation !== _sessionViewGeneration) return false;
  const currentIdentity = getCurrentSessionViewIdentity();
  if (token.identity) {
    return !!currentIdentity
      && currentIdentity.agentId === token.identity.agentId
      && currentIdentity.sessionId === token.identity.sessionId
      && (token.runtimeId === ''
        || normalizeSessionViewRuntimeId(currentRuntimeAgentId) === token.runtimeId);
  }
  return token.runtimeId !== ''
    && normalizeSessionViewRuntimeId(currentRuntimeAgentId) === token.runtimeId;
}

/**
 * Apply one synchronous state/UI transaction if its producer still owns the
 * selected runtime view. Async work must finish before calling this function.
 *
 * @returns {boolean} true when apply() ran, false when the token was stale.
 */
function commitSessionViewState(token, apply) {
  if (typeof apply !== 'function') {
    throw new TypeError('commitSessionViewState requires a synchronous apply function');
  }
  if (!isSessionViewTokenCurrent(token)) {
    return false;
  }
  apply();
  return true;
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
function readCurrentSessionViewState() {
  return Object.freeze({
    runtimeId: normalizeSessionViewRuntimeId(currentRuntimeAgentId),
    identity: getCurrentSessionViewIdentity(),
    switchEpoch: _switchEpoch,
    messages: currentMessages,
    inputRequests: currentInputRequests,
    toolRenderConfigs,
    toolNames: TOOL_NAMES,
    hookInspector: currentHookInspector,
    overview: currentOverviewSnapshot,
    todoPlan: currentTodoPlan,
    sessionMeta: _sessionMeta,
    connected: currentRuntimeConnected,
  });
}

function applySessionViewPatch(patch) {
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
      overview: typeof getEmptyOverviewSnapshot === 'function' ? getEmptyOverviewSnapshot() : {},
      todoPlan: typeof getEmptyTodoPlan === 'function' ? getEmptyTodoPlan() : {},
      sessionMeta: null,
      connected: false,
    };
  }
  if (has('identity')) {
    _sessionViewIdentity = normalizeSessionViewIdentity(patch.identity);
  }
  if (has('messages')) {
    currentMessages = Array.isArray(patch.messages) ? patch.messages : [];
  }
  if (has('inputRequests')) {
    // 相同内容的快照也是新观察，必须阻止更早的响应重新写回旧 lease。
    _sessionViewInputRequestsRevision += 1;
    currentInputRequests = Array.isArray(patch.inputRequests) ? patch.inputRequests : [];
    window.lastInputRequests = currentInputRequests;
    // 工单 037：inputRequests 的规范写入点即输入面的唯一变更声明通道——
    // 写入本身就触发输入面渲染，调用方不再手动 reset 签名 + 调 render。
    // 渲染器未加载时（部分测试沙箱 / 早期启动）声明为 no-op。
    if (typeof notifyInputSurfaceChanged === 'function') {
      notifyInputSurfaceChanged(currentInputRequests);
    }
  }
  if (has('toolRenderConfigs')) {
    toolRenderConfigs = patch.toolRenderConfigs && typeof patch.toolRenderConfigs === 'object'
      ? patch.toolRenderConfigs
      : {};
  }
  if (has('toolNames')) {
    TOOL_NAMES = patch.toolNames && typeof patch.toolNames === 'object'
      ? patch.toolNames
      : {};
  }
  if (has('hookInspector')) {
    setCurrentHookInspector(patch.hookInspector);
  }
  if (has('overview') || has('model')) {
    const runtimeId = normalizeSessionViewRuntimeId(currentRuntimeAgentId);
    setCurrentOverviewSnapshot({
      ...(has('overview') ? patch.overview : currentOverviewSnapshot),
      ...normalizeSessionModelState(has('model') ? patch.model : patch.overview),
    });
    _sessionViewModelRuntimeId = runtimeId;
  }
  if (has('todoPlan')) {
    setCurrentTodoPlan(patch.todoPlan);
  }
  if (has('sessionMeta')) {
    _sessionMeta = normalizeSessionMeta(patch.sessionMeta);
  }
  // 未显式携带 identity 的写入路径（数据加载 / 缓存恢复）由 sessionMeta 推导
  // 会话身份：sessionId 是元数据的一部分，身份与数据必须同源落地，避免
  // loadAgentData 先后两次 patch 之间身份与内容错位。
  if (!has('identity') && has('sessionMeta')) {
    const sessionId = String(_sessionMeta.sessionId || '').trim();
    const host = typeof getCurrentHostAgentRecord === 'function'
      ? getCurrentHostAgentRecord()
      : null;
    const agentId = String(host?.id
      || (typeof focusedAgentId !== 'undefined' ? focusedAgentId : '')
      || '').trim();
    _sessionViewIdentity = normalizeSessionViewIdentity({ agentId, sessionId });
  }
  if (has('connected')) {
    currentRuntimeConnected = patch.connected !== false;
  }
  // 生效身份发生变化（含 null→有值）→ 推进代次，作废全部在途 token。
  const identityAfter = getCurrentSessionViewIdentity();
  const identityFieldsChanged = identityBefore?.agentId !== identityAfter?.agentId
    || identityBefore?.sessionId !== identityAfter?.sessionId;
  if (identityFieldsChanged || (!identityBefore && identityAfter)) {
    _sessionViewGeneration += 1;
  }
}

/**
 * Canonical writer for identity-bound loads, polling, cache restoration and
 * surface resets. It deliberately stores no mirror object: existing globals
 * remain compatibility storage while consumers migrate to the read-only view.
 * Input snapshots additionally use the revision captured before I/O: an intervening
 * write drops only inputRequests, preserving other fields and the current view.
 * A true return value means the view transaction ran, not that every field applied.
 */
function commitSessionViewPatch(token, patch, afterCommit) {
  if (afterCommit !== undefined && typeof afterCommit !== 'function') {
    throw new TypeError('session view afterCommit must be a function');
  }
  return commitSessionViewState(token, () => {
    const previous = readCurrentSessionViewState();
    if (Object.prototype.hasOwnProperty.call(patch, 'inputRequests')
      && !isSessionViewInputRequestsCurrent(token)) {
      patch = { ...patch };
      delete patch.inputRequests;
    }
    // 异步生产者的回执和快照共用版本判据；同步 reset / cache restore
    // 走 applySessionViewPatch，明确替换整个视图，不受旧版本阻挡。
    const hasModel = Object.prototype.hasOwnProperty.call(patch, 'model');
    const hasOverview = Object.prototype.hasOwnProperty.call(patch, 'overview');
    if ((hasModel || hasOverview) && _sessionViewModelRuntimeId === previous.runtimeId) {
      const incoming = normalizeSessionModelState(hasModel ? patch.model : patch.overview);
      const current = normalizeSessionModelState(previous.overview);
      if (current.modelRevision !== null
        && (incoming.modelRevision === null || incoming.modelRevision < current.modelRevision)) {
        patch = { ...patch, model: current };
      }
    }
    applySessionViewPatch(patch);
    if (afterCommit) {
      afterCommit({
        previous,
        current: readCurrentSessionViewState(),
      });
    }
  });
}
