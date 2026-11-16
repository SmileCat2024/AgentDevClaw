import { createSessionDataLoader } from './session-data-loader.js';
import { setCurrentRuntimeAgentId } from './orchestration-state.js';
import { focusedAgentId } from './agent-store-state.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { isSessionViewTokenCurrent, isSessionViewMessagesCurrent, commitSessionViewPatch } from './session-view-commit-host.js';
import { loadFeatureTemplateMap, loadAgentDetail } from './agent-loader-host.js';
import { refreshCurrentRuntimeStatus } from './runtime-status-loader-host.js';

const loader = createSessionDataLoader({
  ...window.createSessionDataLoaderHost(),
  setRuntime: setCurrentRuntimeAgentId,
  focused: () => focusedAgentId,
  activePanel: () => activeFeaturePanel,
  isCurrent: isSessionViewTokenCurrent,
  messagesCurrent: isSessionViewMessagesCurrent,
  patch: commitSessionViewPatch,
  loadTemplates: loadFeatureTemplateMap,
  loadDetail: loadAgentDetail,
  refreshStatus: refreshCurrentRuntimeStatus,
});
export const { loadAgentData } = loader;
window.KernelState.defineKey('session-data-loader', 'loadAgentData', loadAgentData);
window.KernelState.claim('session-data-loader', {
  get: (key) => loader[key],
  set: (key, value) => { loader[key] = value; },
});
