// Late-bound adapter over the classic agent-call-states sync owner composed in
// app-main.js. The owner creates the only engine instance and registers the two
// bridge keys used by classic consumers; this module never initializes, claims,
// or re-registers anything.

function owner() {
  const states = window.ClawFW && window.ClawFW.CallStates;
  if (!states) throw new Error('[claw] agent-call-states classic sync owner is not initialized');
  return states;
}

export function collectActiveCallRuntimeIds(...args) {
  return owner().collectActiveCallRuntimeIds(...args);
}

export function applyAgentCallStateFromNotification(...args) {
  return owner().applyAgentCallStateFromNotification(...args);
}

export function applyCallStateToAgentRecords(...args) {
  return owner().applyCallStateToAgentRecords(...args);
}

export function refreshAgentCallStates(...args) {
  return owner().refreshAgentCallStates(...args);
}
