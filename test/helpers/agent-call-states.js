/**
 * Classic agent-call-states owner accessor.
 *
 * The production engine instance is composed by the bootstrap IIFE in
 * public/src/app-main.js (after app-core/runtime-status/sidebar-render) and
 * exposed as window.ClawFW.CallStates. This helper no longer builds a second
 * instance; it only verifies the real owner is installed and returns it.
 */
export function installAgentCallStates(context) {
  const states = context.ClawFW && context.ClawFW.CallStates;
  if (!states) {
    throw new Error('[test] classic agent-call-states owner not loaded (app-main bootstrap missing)');
  }
  return states;
}
