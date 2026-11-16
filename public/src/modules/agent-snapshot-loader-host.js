import { createAgentSnapshotLoader } from './agent-snapshot-loader.js';
import * as store from './agent-store-state.js';
import { loadAgentDetail } from './agent-loader-host.js';
import { refreshAgentCallStates } from './agent-call-states-host.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { loadAgentData } from './session-data-loader-host.js';

const host = window.createAgentSnapshotLoaderHost();
const loader = createAgentSnapshotLoader({
  ...host,
  state: {
    get agents() { return store.allAgents; }, set agents(value) { store.setAllAgents(value); },
    get inFlight() { return store.loadAgentsInFlight; }, set inFlight(value) { store.setLoadAgentsInFlight(value); },
    get focused() { return store.focusedAgentId; }, set focused(value) { store.setFocusedAgentId(value); },
    get suppressRender() { return host.state.suppressRender; },
    get activePanel() { return activeFeaturePanel; },
  },
  loadDetail: loadAgentDetail,
  refreshCalls: refreshAgentCallStates,
  loadData: loadAgentData,
});
export const { loadAgents } = loader;
window.KernelState.defineKey('agent-snapshot-loader', 'loadAgents', loadAgents);
window.KernelState.claim('agent-snapshot-loader', {
  get: (key) => loader[key],
  set: (key, value) => { loader[key] = value; },
});
