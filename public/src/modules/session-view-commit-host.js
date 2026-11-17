import { createSessionViewCommit } from './session-view-commit.js';
import * as identity from './session-view-identity-state.js';
import * as orchestration from './orchestration-state.js';

const policy = createSessionViewCommit({
  ...window.createSessionViewCommitHost(),
  messagesRevision: () => identity._sessionViewMessagesRevision,
  inputRequestsRevision: () => identity._sessionViewInputRequestsRevision,
  switchEpoch: () => orchestration._switchEpoch,
  generation: () => identity._sessionViewGeneration,
  runtimeId: () => String(orchestration.currentRuntimeAgentId || '').trim(),
  modelRuntimeId: () => identity._sessionViewModelRuntimeId,
});
export const { isSessionViewMessagesCurrent, isSessionViewInputRequestsCurrent,
  isSessionViewTokenCurrent, commitSessionViewState, commitSessionViewPatch } = policy;
window.KernelState.defineKey('session-view-commit', 'isSessionViewInputRequestsCurrent', isSessionViewInputRequestsCurrent);
window.KernelState.defineKey('session-view-commit', 'isSessionViewTokenCurrent', isSessionViewTokenCurrent);
window.KernelState.defineKey('session-view-commit', 'commitSessionViewState', commitSessionViewState);
window.KernelState.defineKey('session-view-commit', 'commitSessionViewPatch', commitSessionViewPatch);
window.KernelState.claim('session-view-commit', {
  get: (key) => policy[key],
  set: (key, value) => { policy[key] = value; },
});
