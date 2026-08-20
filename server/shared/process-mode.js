import { sanitizeSessionFragment, cleanSessionText } from './string-helpers.js';
import { PH_STYLE_WORKSPACE_AGENT_IDS } from './constants.js';

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
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (normalizedAgentId === GLOBAL_SHARED_AGENT_ID || PH_STYLE_WORKSPACE_AGENT_IDS.has(normalizedAgentId)) {
    const configured = normalizeProgrammingHelperProcessMode(configuredMode);
    // shared-global 进程宿主仍限定 programming-helper（见 agent-startup.js 设计注释）
    if (configured === PROCESS_MODE_SHARED_GLOBAL && normalizedAgentId !== GLOBAL_SHARED_AGENT_ID) {
      return normalizeProgrammingHelperProcessMode(defaultMode) || PROCESS_MODE_ISOLATED;
    }
    return configured || normalizeProgrammingHelperProcessMode(defaultMode) || PROCESS_MODE_ISOLATED;
  }
  return cleanSessionText(defaultMode) || PROCESS_MODE_ISOLATED;
}
