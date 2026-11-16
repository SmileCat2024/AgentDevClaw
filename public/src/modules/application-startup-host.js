import { createApplicationStartup } from './application-startup.js';
import { loadFeatureTemplateMap, reloadFeatureTemplateMap } from './agent-loader-host.js';
import { loadAgents } from './agent-snapshot-loader-host.js';
import { poll } from './poll-coordinator-host.js';

const startup = createApplicationStartup({
  ...window.createApplicationStartupHost(),
  loadTemplates: loadFeatureTemplateMap,
  reloadTemplates: reloadFeatureTemplateMap,
  loadAgents,
  poll,
});
export const { startApplication } = startup;
window.KernelState.defineKey('application-startup', 'startApplication', startApplication);
window.KernelState.claim('application-startup', {
  get: key => startup[key],
  set: (key, value) => { startup[key] = value; },
});
