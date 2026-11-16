import { createAgentLoader } from './agent-loader.js';
import { allAgents } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { toolRenderConfigs } from './session-view-storage.js';

export let FEATURE_TEMPLATE_MAP;
const loader = createAgentLoader({
  loadedAgentDetailIds: window.AgentLoaderHost.loadedAgentDetailIds,
  currentRuntimeAgentId: () => currentRuntimeAgentId,
  fetch: (...args) => window.fetch(...args),
  setFeatureTemplateMap: (value) => { FEATURE_TEMPLATE_MAP = value; },
  allAgents: () => allAgents,
  // Classic functions remain late-bound until their own domains migrate.
  getPhSessionOwnershipParams: (agent) => typeof window.getPhSessionOwnershipParams === 'function'
    ? window.getPhSessionOwnershipParams(agent) : {},
  captureSidebarSnapshotToken: () => typeof window.captureSidebarSnapshotToken === 'function'
    ? window.captureSidebarSnapshotToken() : null,
  isSidebarSnapshotTokenCurrent: (token) => typeof window.isSidebarSnapshotTokenCurrent !== 'function'
    || window.isSidebarSnapshotTokenCurrent(token),
  captureSessionViewToken: () => typeof window.captureSessionViewToken === 'function'
    ? window.captureSessionViewToken() : null,
  commitSessionViewPatch: (...args) => typeof window.commitSessionViewPatch === 'function'
    && window.commitSessionViewPatch(...args),
  get mergeWorkspaceSessionSnapshots() { return window.mergeWorkspaceSessionSnapshots; },
  updateChatContextBar: (...args) => typeof window.updateChatContextBar === 'function'
    && window.updateChatContextBar(...args),
  renderCurrentMainView: (...args) => typeof window.renderCurrentMainView === 'function'
    && window.renderCurrentMainView(...args),
  toolRenderConfigs: () => toolRenderConfigs,
  collectTemplateNames: (...args) => window.collectTemplateNames(...args),
  warmTemplatesInBackground: (...args) => window.warmTemplatesInBackground(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.info(...args),
  log: (...args) => console.log(...args),
});

export const { loadFeatureTemplateMap, reloadFeatureTemplateMap, loadAgentDetail,
  getAgentDetailPayload, extractSessionMetaFromDetail } = loader;

window.KernelState.defineKey('agent-loader', 'loadFeatureTemplateMap', loadFeatureTemplateMap);
window.KernelState.defineKey('agent-loader', 'reloadFeatureTemplateMap', reloadFeatureTemplateMap);
window.KernelState.defineKey('agent-loader', 'loadAgentDetail', loadAgentDetail);
window.KernelState.defineKey('agent-loader', 'getAgentDetailPayload', getAgentDetailPayload);
window.KernelState.defineKey('agent-loader', 'extractSessionMetaFromDetail', extractSessionMetaFromDetail);
const compatibility = { ...loader };
window.KernelState.claim('agent-loader', {
  get: (key) => key === 'FEATURE_TEMPLATE_MAP' ? FEATURE_TEMPLATE_MAP : compatibility[key],
  set(key, value) {
    if (key === 'FEATURE_TEMPLATE_MAP') FEATURE_TEMPLATE_MAP = value;
    else compatibility[key] = value;
  },
});
