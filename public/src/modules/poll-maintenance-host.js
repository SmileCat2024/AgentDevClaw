import { createPollMaintenance } from './poll-maintenance.js';
import { allAgents, focusedAgentId, lastAgentListRefreshAt, setLastAgentListRefreshAt } from './agent-store-state.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { currentHookInspectorSignature } from './session-view-storage.js';
import { isSessionViewTokenCurrent, commitSessionViewState, commitSessionViewPatch } from './session-view-commit-host.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { refreshAgentCallStates } from './agent-call-states-host.js';
import { saveCurrentRuntimeToCache } from './runtime-view-cache-host.js';

const maintenance = createPollMaintenance({
  ...window.createPollMaintenanceHost(),
  agents: () => allAgents,
  focused: () => focusedAgentId,
  lastAgentRefresh: () => lastAgentListRefreshAt,
  setAgentRefresh: setLastAgentListRefreshAt,
  panel: () => activeFeaturePanel,
  currentHookSignature: () => currentHookInspectorSignature,
  isCurrent: isSessionViewTokenCurrent,
  commit: commitSessionViewState,
  patch: commitSessionViewPatch,
  loadAgents,
  refreshCalls: refreshAgentCallStates,
  saveCache: saveCurrentRuntimeToCache,
});
export const { refreshUnfocusedPoll, _runPollTailLowFrequency } = maintenance;
window.KernelState.defineKey('poll-maintenance', 'refreshUnfocusedPoll', refreshUnfocusedPoll);
window.KernelState.defineKey('poll-maintenance', '_runPollTailLowFrequency', _runPollTailLowFrequency);
window.KernelState.claim('poll-maintenance', {
  get: (key) => maintenance[key],
  set: (key, value) => { maintenance[key] = value; },
});
