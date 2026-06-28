const _readyCallbacks = [];

export function onRuntimeReady(cb) { _readyCallbacks.push(cb); }

export function notifyRuntimeReady(agentId, sessionId) {
  for (const cb of _readyCallbacks) {
    try { cb(agentId, sessionId); } catch (e) { console.error('[runtime-hook]', e); }
  }
}
