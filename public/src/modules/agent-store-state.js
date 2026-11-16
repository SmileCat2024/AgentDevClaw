// ESM owner for app-core agent-store mutable slots. Classic functions keep
// using the accessors until they migrate; claim absorbs their early writes.
export let allAgents;
export let focusedAgentId;
export let readOnlyMode;
export let loadAgentsInFlight;
export let lastAgentListRefreshAt;
export let lastCallStateRefreshAt;
export let expandedProjectIds;

window.KernelState.claim('agent-store', {
  get(key) {
    switch (key) {
      case 'allAgents': return allAgents;
      case 'focusedAgentId': return focusedAgentId;
      case 'readOnlyMode': return readOnlyMode;
      case 'loadAgentsInFlight': return loadAgentsInFlight;
      case 'lastAgentListRefreshAt': return lastAgentListRefreshAt;
      case 'lastCallStateRefreshAt': return lastCallStateRefreshAt;
      case 'expandedProjectIds': return expandedProjectIds;
    }
  },
  set(key, value) {
    switch (key) {
      case 'allAgents': allAgents = value; break;
      case 'focusedAgentId': focusedAgentId = value; break;
      case 'readOnlyMode': readOnlyMode = value; break;
      case 'loadAgentsInFlight': loadAgentsInFlight = value; break;
      case 'lastAgentListRefreshAt': lastAgentListRefreshAt = value; break;
      case 'lastCallStateRefreshAt': lastCallStateRefreshAt = value; break;
      case 'expandedProjectIds': expandedProjectIds = value; break;
    }
  },
});

export const setAllAgents = (value) => { allAgents = value; };
export const setFocusedAgentId = (value) => { focusedAgentId = value; };
export const setReadOnlyMode = (value) => { readOnlyMode = value; };
export const setLoadAgentsInFlight = (value) => { loadAgentsInFlight = value; };
export const setLastAgentListRefreshAt = (value) => { lastAgentListRefreshAt = value; };
export const setLastCallStateRefreshAt = (value) => { lastCallStateRefreshAt = value; };
export const setExpandedProjectIds = (value) => { expandedProjectIds = value; };
