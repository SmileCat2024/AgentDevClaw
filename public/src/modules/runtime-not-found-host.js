import { createRuntimeNotFound } from './runtime-not-found.js';
import { isSessionViewTokenCurrent, commitSessionViewPatch } from './session-view-commit-host.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { schedulePoll } from './poll-coordinator-host.js';

const policy = createRuntimeNotFound({
  ...window.createRuntimeNotFoundHost(),
  isCurrent: isSessionViewTokenCurrent,
  patch: commitSessionViewPatch,
  loadAgents,
  schedule: schedulePoll,
});
export const { handleCoreResponsesNotFound } = policy;
window.KernelState.defineKey('runtime-not-found', 'handleCoreResponsesNotFound', handleCoreResponsesNotFound);
window.KernelState.claim('runtime-not-found', {
  get: (key) => policy[key],
  set: (key, value) => { policy[key] = value; },
});
