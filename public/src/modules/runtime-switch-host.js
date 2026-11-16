import { createRuntimeSwitch } from './runtime-switch.js';
import * as navigation from './orchestration-state.js';
import * as agents from './agent-store-state.js';
import * as view from './render-entry-state.js';
import { saveCurrentRuntimeToCache, restoreRuntimeFromCache } from './runtime-view-cache-host.js';
import { loadAgentData } from './session-data-loader-host.js';
import { loadAgents } from './agent-snapshot-loader-host.js';

const host = window.createRuntimeSwitchHost();
const state = host.state;
Object.defineProperties(state, {
  pendingSwitchTarget: { get: () => navigation.pendingSwitchTarget, set: navigation.setPendingSwitchTarget },
  pendingSwitchSerial: { get: () => navigation.pendingSwitchSerial, set: navigation.setPendingSwitchSerial },
  navigationEpoch: { get: () => navigation._navigationGuardEpoch },
  switchEpoch: { get: () => navigation._switchEpoch, set: navigation.setSwitchEpoch },
  runtimeId: { get: () => navigation.currentRuntimeAgentId, set: navigation.setCurrentRuntimeAgentId },
  focusedAgentId: { get: () => agents.focusedAgentId, set: agents.setFocusedAgentId },
  readOnlyMode: { get: () => agents.readOnlyMode, set: agents.setReadOnlyMode },
  lastRenderedWorkspaceHtml: { get: () => view.lastRenderedWorkspaceHtml, set: view.setLastRenderedWorkspaceHtml },
  restoredScrollTop: { get: () => navigation._restoredScrollTop, set: navigation.setRestoredScrollTop },
});
const transaction = createRuntimeSwitch({ ...host,
  saveCache: saveCurrentRuntimeToCache,
  restoreCache: restoreRuntimeFromCache,
  loadData: loadAgentData,
  loadAgents,
});
export const { switchAgent, requestSwitch } = transaction;
window.KernelState.defineKey('runtime-switch', 'switchAgent', switchAgent);
window.KernelState.defineKey('runtime-switch', 'requestSwitch', requestSwitch);
window.KernelState.claim('runtime-switch', {
  get: key => transaction[key],
  set: (key, value) => { transaction[key] = value; },
});
