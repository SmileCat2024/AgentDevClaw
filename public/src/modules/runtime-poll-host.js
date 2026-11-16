import { createRuntimePoll } from './runtime-poll.js';
import { allAgents } from './agent-store-state.js';
import { commitSessionViewState, isSessionViewTokenCurrent } from './session-view-commit-host.js';
import { refreshContextGuardStatus, refreshCurrentRuntimeStatus } from './runtime-status-loader-host.js';
import { refreshAgentCallStates } from './agent-call-states-host.js';
import { runMessagesProbeCycle } from './message-probe-host.js';
import { commitMetadataUpdate } from './metadata-commit-host.js';
import { schedulePoll } from './poll-coordinator-host.js';
import { _runPollTailLowFrequency } from './poll-maintenance-host.js';

const runtime = createRuntimePoll({
  ...window.createRuntimePollHost(),
  agents: () => allAgents,
  commit: commitSessionViewState,
  isCurrent: isSessionViewTokenCurrent,
  guard: refreshContextGuardStatus,
  status: refreshCurrentRuntimeStatus,
  refreshCalls: refreshAgentCallStates,
  messages: runMessagesProbeCycle,
  metadata: commitMetadataUpdate,
  schedule: schedulePoll,
  tail: _runPollTailLowFrequency,
});
export const { runRuntimePoll } = runtime;
window.KernelState.defineKey('runtime-poll', 'runRuntimePoll', runRuntimePoll);
window.KernelState.claim('runtime-poll', {
  get: (key) => runtime[key],
  set: (key, value) => { runtime[key] = value; },
});
