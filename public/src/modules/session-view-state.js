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
 */

function normalizeSessionViewRuntimeId(value) {
  return String(value || '').trim();
}

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

function readCurrentSessionViewState() {
  return Object.freeze({
    messages: currentMessages,
    inputRequests: currentInputRequests,
    toolRenderConfigs,
    toolNames: TOOL_NAMES,
    hookInspector: currentHookInspector,
    overview: currentOverviewSnapshot,
    todoPlan: currentTodoPlan,
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
  if (has('connected')) {
    currentRuntimeConnected = patch.connected !== false;
  }
}

/**
 * Canonical writer for identity-bound loads, polling, cache restoration and
 * surface resets. It deliberately stores no mirror object: existing globals
 * remain the compatibility read surface while interaction modules migrate in
 * later steps.
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
