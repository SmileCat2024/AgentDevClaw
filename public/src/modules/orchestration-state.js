// ESM owner for orchestration mutable slots. Existing switch/navigation
// functions remain classic and keep using the window accessors until migrated.
export let currentRuntimeAgentId;
export let _switchEpoch;
export let pendingSwitchTarget;
export let pendingSwitchSerial;
export let _navigationGuardEpoch;
export let _pendingSessionNavigation;
export let _chatLoadingSession;
// 唯一 owner（桥已注销：无 classic 消费方）。初值 null 与撤桥前 defineKey 初值一致，
// 计时句柄语义（同引用经 setChatLoadingTimeout 传入、清理后回 null）原样保留。
export let _chatLoadingTimeout = null;
export let _restoredScrollTop;

window.KernelState.claim('orchestration', {
  get(key) {
    switch (key) {
      case 'currentRuntimeAgentId': return currentRuntimeAgentId;
      case '_switchEpoch': return _switchEpoch;
      case 'pendingSwitchTarget': return pendingSwitchTarget;
      case 'pendingSwitchSerial': return pendingSwitchSerial;
      case '_navigationGuardEpoch': return _navigationGuardEpoch;
      case '_pendingSessionNavigation': return _pendingSessionNavigation;
      case '_chatLoadingSession': return _chatLoadingSession;
      case '_restoredScrollTop': return _restoredScrollTop;
    }
  },
  set(key, value) {
    switch (key) {
      case 'currentRuntimeAgentId': currentRuntimeAgentId = value; break;
      case '_switchEpoch': _switchEpoch = value; break;
      case 'pendingSwitchTarget': pendingSwitchTarget = value; break;
      case 'pendingSwitchSerial': pendingSwitchSerial = value; break;
      case '_navigationGuardEpoch': _navigationGuardEpoch = value; break;
      case '_pendingSessionNavigation': _pendingSessionNavigation = value; break;
      case '_chatLoadingSession': _chatLoadingSession = value; break;
      case '_restoredScrollTop': _restoredScrollTop = value; break;
    }
  },
});

export const setCurrentRuntimeAgentId = (value) => { currentRuntimeAgentId = value; };
export const setSwitchEpoch = (value) => { _switchEpoch = value; };
export const setPendingSwitchTarget = (value) => { pendingSwitchTarget = value; };
export const setPendingSwitchSerial = (value) => { pendingSwitchSerial = value; };
export const setNavigationGuardEpoch = (value) => { _navigationGuardEpoch = value; };
export const setPendingSessionNavigation = (value) => { _pendingSessionNavigation = value; };
export const setChatLoadingSession = (value) => { _chatLoadingSession = value; };
export const setChatLoadingTimeout = (value) => { _chatLoadingTimeout = value; };
export const setRestoredScrollTop = (value) => { _restoredScrollTop = value; };
