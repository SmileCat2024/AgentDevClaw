import { createAgentCallStates } from '../../public/src/modules/agent-call-states.js';

export function installAgentCallStates(context) {
  const states = createAgentCallStates({
    ...context.createAgentCallStatesHost(),
    callStartedAt: (...args) => context.getNotificationCallStartedAt(...args),
    isInterruptSuppressed: (...args) => context.isInterruptSuppressed(...args),
    clearInterrupt: (...args) => context.clearInterruptSuppression(...args),
  });
  Object.assign(context, states);
  return states;
}
