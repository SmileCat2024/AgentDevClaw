import { sanitizeSessionFragment, cleanSessionText } from './string-helpers.js';

export const PROCESS_MODE_ISOLATED = 'isolated';
export const PROCESS_MODE_SHARED_BY_PROJECT = 'shared-by-project';
export const PROCESS_MODE_SHARED_GLOBAL = 'shared-global';
export const GLOBAL_SHARED_AGENT_ID = 'programming-helper';

const PROGRAMMING_HELPER_PROCESS_MODES = new Set([
  PROCESS_MODE_ISOLATED,
  PROCESS_MODE_SHARED_BY_PROJECT,
  PROCESS_MODE_SHARED_GLOBAL,
]);

export function normalizeProgrammingHelperProcessMode(value) {
  const processMode = cleanSessionText(value);
  return PROGRAMMING_HELPER_PROCESS_MODES.has(processMode) ? processMode : null;
}

export function resolveAgentProcessMode(agentId, configuredMode, defaultMode = PROCESS_MODE_ISOLATED) {
  if (sanitizeSessionFragment(agentId) === GLOBAL_SHARED_AGENT_ID) {
    return normalizeProgrammingHelperProcessMode(configuredMode)
      || normalizeProgrammingHelperProcessMode(defaultMode)
      || PROCESS_MODE_ISOLATED;
  }
  return cleanSessionText(defaultMode) || PROCESS_MODE_ISOLATED;
}
