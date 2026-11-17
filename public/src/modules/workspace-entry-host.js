import { createWorkspaceEntry, createWorkspaceSessionRequest } from './workspace-entry.js';
import { allAgents, setFocusedAgentId } from './agent-store-state.js';
import { _navigationGuardEpoch } from './orchestration-state.js';
import { loadAgentDetail } from './agent-loader-host.js';
import { switchAgent, requestSwitch } from './runtime-switch-host.js';

const entry = createWorkspaceEntry({
  ...window.createWorkspaceEntryHost(),
  findWorkspace: id => allAgents.find(agent => agent.id === id && agent.source === 'prebuilt'),
  focus: setFocusedAgentId,
  navigationEpoch: () => _navigationGuardEpoch,
  // 静态环内惰性转调（同 session-data-loader-host）：环可能先求值本模块。
  loadDetail: (...args) => loadAgentDetail(...args),
  switchAgent,
  requestSwitch,
});
const request = createWorkspaceSessionRequest({ fetch: (...args) => window.fetch(...args) });
const compatibility = { ...entry, ...request };
export const { handlePrebuiltAgentClick } = entry;
export const { openPrebuiltWorkspaceSession } = request;
window.KernelState.defineKey('workspace-entry', 'handlePrebuiltAgentClick', handlePrebuiltAgentClick);
window.KernelState.claim('workspace-entry', {
  get: key => compatibility[key],
  set: (key, value) => { compatibility[key] = value; },
});
