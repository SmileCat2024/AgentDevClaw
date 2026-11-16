import { createMetadataCommit } from './metadata-commit.js';
import { createCommittedViewRenderer } from './committed-view-renderer.js';
import { currentOverviewSignature, currentTodoPlanSignature, currentInputRequests } from './session-view-storage.js';
import { isSessionViewInputRequestsCurrent, commitSessionViewPatch } from './session-view-commit-host.js';

const metadata = createMetadataCommit({
  ...window.createMetadataCommitHost(createCommittedViewRenderer),
  inputCurrent: isSessionViewInputRequestsCurrent,
  commit: commitSessionViewPatch,
  currentOverviewSignature: () => currentOverviewSignature,
  currentTodoSignature: () => currentTodoPlanSignature,
  inputRequests: () => currentInputRequests,
});
export const { commitMetadataUpdate } = metadata;
window.KernelState.defineKey('metadata-commit', 'commitMetadataUpdate', commitMetadataUpdate);
window.KernelState.claim('metadata-commit', {
  get: (key) => metadata[key],
  set: (key, value) => { metadata[key] = value; },
});
