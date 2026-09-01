/**
 * session-view-state.js — selected runtime view ownership boundary.
 *
 * Async producers may read the same runtime at different moments. They must
 * capture a token before starting I/O and submit synchronous state/UI changes
 * through commitSessionViewPatch(). A runtime id alone is insufficient because
 * the user can leave and re-enter the same runtime while an older request is
 * still in flight.
 *
 * This module owns only commit eligibility. The poll timer and in-flight
 * promises remain runtime resources owned by the poll coordinator.
 *
 * `sessionMeta` carries the selected session's rich metadata (session id,
 * type, timestamps, working directory, message count). Volatile display
 * fields (title, model name, live usage) deliberately stay out: they
 * resolve through live sources (catalog accessor / overview snapshot) so
 * renames and model swaps surface without waiting for a detail reload.
 * It is written as a whole replacement snapshot by the data-load / switch
 * paths and is read-only for consumers.
 */

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

let _sessionMeta = EMPTY_SESSION_META;

function captureSessionViewToken(runtimeId = currentRuntimeAgentId) {
  return Object.freeze({
    runtimeId: normalizeSessionViewRuntimeId(runtimeId),
    switchEpoch: _switchEpoch,
  });
}

function isSessionViewTokenCurrent(token) {
  return !!token
    && token.runtimeId !== ''
    && normalizeSessionViewRuntimeId(currentRuntimeAgentId) === token.runtimeId
    && _switchEpoch === token.switchEpoch;
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
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  if (has('messages')) {
    currentMessages = Array.isArray(patch.messages) ? patch.messages : [];
  }
  if (has('inputRequests')) {
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
  if (has('overview')) {
    setCurrentOverviewSnapshot(patch.overview);
  }
  if (has('todoPlan')) {
    setCurrentTodoPlan(patch.todoPlan);
  }
  if (has('sessionMeta')) {
    _sessionMeta = normalizeSessionMeta(patch.sessionMeta);
  }
  if (has('connected')) {
    currentRuntimeConnected = patch.connected !== false;
  }
}

/**
 * Canonical writer for identity-bound loads, polling, cache restoration and
 * surface resets. It deliberately stores no mirror object: existing globals
 * remain compatibility storage while consumers migrate to the read-only view.
 */
function commitSessionViewPatch(token, patch, afterCommit) {
  if (afterCommit !== undefined && typeof afterCommit !== 'function') {
    throw new TypeError('session view afterCommit must be a function');
  }
  return commitSessionViewState(token, () => {
    const previous = readCurrentSessionViewState();
    applySessionViewPatch(patch);
    if (afterCommit) {
      afterCommit({
        previous,
        current: readCurrentSessionViewState(),
      });
    }
  });
}
