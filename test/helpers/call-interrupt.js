import { createCallInterruptState } from '../../public/src/modules/call-interrupt-state.js';

export function installCallInterruptState(context) {
  const host = context.createCallInterruptHost();
  const policy = createCallInterruptState(host.pending, host.now);
  Object.assign(context, policy);
  return policy;
}
