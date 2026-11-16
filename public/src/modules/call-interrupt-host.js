import { createCallInterruptState } from './call-interrupt-state.js';

const host = window.createCallInterruptHost();
const policy = createCallInterruptState(host.pending, host.now);
export const { getNotificationCallStartedAt, markInterruptPending,
  isInterruptSuppressed, clearInterruptSuppression } = policy;

window.KernelState.defineKey('call-interrupt', 'getNotificationCallStartedAt', getNotificationCallStartedAt);
window.KernelState.defineKey('call-interrupt', 'markInterruptPending', markInterruptPending);
window.KernelState.defineKey('call-interrupt', 'isInterruptSuppressed', isInterruptSuppressed);
window.KernelState.defineKey('call-interrupt', 'clearInterruptSuppression', clearInterruptSuppression);
window.KernelState.claim('call-interrupt', {
  get: (key) => policy[key],
  set: (key, value) => { policy[key] = value; },
});
