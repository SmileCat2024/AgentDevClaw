import { createWorkspaceSurface } from './workspace-surface.js';
import { beginChatLoadingSession } from './chat-loading-host.js';
import { allAgents, focusedAgentId, readOnlyMode } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { saveCurrentRuntimeToCache } from './runtime-view-cache-host.js';
import { loadAgentDetail } from './agent-loader-host.js';

const navigation = createWorkspaceSurface({
  ...window.createWorkspaceSurfaceHost(),
  findAgent: id => allAgents.find(agent => agent.id === id) || null,
  focusedAgentId: () => focusedAgentId,
  runtimeId: () => currentRuntimeAgentId,
  readOnlyMode: () => readOnlyMode,
  saveCache: saveCurrentRuntimeToCache,
  loadDetail: loadAgentDetail,
  beginLoading: beginChatLoadingSession,
});
export const { selectWorkspaceSurface } = navigation;
window.KernelState.defineKey('workspace-surface', 'selectWorkspaceSurface', selectWorkspaceSurface);
window.KernelState.claim('workspace-surface', {
  get: key => navigation[key],
  set: (key, value) => { navigation[key] = value; },
});
