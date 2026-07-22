/**
 * session-view-state.js — selected runtime view ownership boundary.
 *
 * Async producers may read the same runtime at different moments. They must
 * capture a token before starting I/O and submit synchronous state/UI changes
 * through commitSessionViewState(). A runtime id alone is insufficient because
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
