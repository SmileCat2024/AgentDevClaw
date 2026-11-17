import { createWorkspaceSessionNavigation } from './workspace-session-navigation.js';
import { _navigationGuardEpoch, currentRuntimeAgentId } from './orchestration-state.js';
import { allAgents, focusedAgentId, readOnlyMode } from './agent-store-state.js';
import { saveCurrentRuntimeToCache } from './runtime-view-cache-host.js';
import { loadAgentDetail } from './agent-loader-host.js';

const navigation = createWorkspaceSessionNavigation({
  ...window.createWorkspaceSessionNavigationHost(),
  navigationEpoch: () => _navigationGuardEpoch,
  focusedAgentId: () => focusedAgentId,
  runtimeId: () => currentRuntimeAgentId,
  readOnlyMode: () => readOnlyMode,
  findWorkspace: id => allAgents.find(agent => agent.id === id && agent.source === 'prebuilt'),
  saveCache: saveCurrentRuntimeToCache,
  // 静态环内惰性转调（同 session-data-loader-host）：环可能先求值本模块。
  loadDetail: (...args) => loadAgentDetail(...args),
});
export const { navigateToWorkspaceSession } = navigation;
window.KernelState.defineKey('workspace-session-navigation', 'navigateToWorkspaceSession', navigateToWorkspaceSession);
window.KernelState.claim('workspace-session-navigation', {
  get: key => navigation[key],
  set: (key, value) => { navigation[key] = value; },
});
