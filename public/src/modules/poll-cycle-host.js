import { createPollCycle } from './poll-cycle.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { FEATURE_TEMPLATE_MAP, reloadFeatureTemplateMap } from './agent-loader-host.js';
import { runRuntimePoll } from './runtime-poll-host.js';
import { schedulePoll } from './poll-coordinator-host.js';

const cycle = createPollCycle({
  ...window.createPollCycleHost(),
  runtimeId: () => currentRuntimeAgentId,
  templates: () => FEATURE_TEMPLATE_MAP,
  reloadTemplates: reloadFeatureTemplateMap,
  runtime: runRuntimePoll,
  schedule: schedulePoll,
});
export const { runPollCycle } = cycle;
window.KernelState.defineKey('poll-cycle', 'runPollCycle', runPollCycle);
window.KernelState.claim('poll-cycle', {
  get: (key) => cycle[key],
  set: (key, value) => { cycle[key] = value; },
});
