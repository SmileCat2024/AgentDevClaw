import { createAgentCallStates } from './agent-call-states.js';
import { getNotificationCallStartedAt, isInterruptSuppressed, clearInterruptSuppression } from './call-interrupt-host.js';

const states = createAgentCallStates({
  ...window.createAgentCallStatesHost(),
  callStartedAt: getNotificationCallStartedAt,
  isInterruptSuppressed,
  clearInterrupt: clearInterruptSuppression,
});
export const { collectActiveCallRuntimeIds, applyAgentCallStateFromNotification,
  applyCallStateToAgentRecords, refreshAgentCallStates } = states;
window.KernelState.defineKey('agent-call-states', 'collectActiveCallRuntimeIds', collectActiveCallRuntimeIds);
window.KernelState.defineKey('agent-call-states', 'applyAgentCallStateFromNotification', applyAgentCallStateFromNotification);
window.KernelState.defineKey('agent-call-states', 'refreshAgentCallStates', refreshAgentCallStates);
window.KernelState.claim('agent-call-states', {
  get: (key) => states[key],
  set: (key, value) => { states[key] = value; },
});
