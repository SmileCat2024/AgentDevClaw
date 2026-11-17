import { createRuntimeStatusLoader } from './runtime-status-loader.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { isSessionViewTokenCurrent, commitSessionViewState, commitSessionViewPatch } from './session-view-commit-host.js';
import { createRuntimeStatusLoaderHost } from './agent-data-loader.js';

const loader = createRuntimeStatusLoader({
  ...createRuntimeStatusLoaderHost(),
  runtimeId: () => currentRuntimeAgentId,
  isCurrent: isSessionViewTokenCurrent,
  commit: commitSessionViewState,
  patch: commitSessionViewPatch,
});
export const { refreshCurrentRuntimeStatus, refreshContextGuardStatus } = loader;
window.KernelState.defineKey('runtime-status-loader', 'refreshCurrentRuntimeStatus', refreshCurrentRuntimeStatus);
window.KernelState.defineKey('runtime-status-loader', 'refreshContextGuardStatus', refreshContextGuardStatus);
window.KernelState.claim('runtime-status-loader', {
  get: (key) => loader[key],
  set: (key, value) => { loader[key] = value; },
});
