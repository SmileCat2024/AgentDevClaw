import vm from 'node:vm';
import { createSessionViewCommit } from '../../public/src/modules/session-view-commit.js';

// Run real ESM policy against the live classic sandbox, not copied snapshots.
export function installSessionViewCommit(context) {
  const read = (expression) => () => vm.runInContext(expression, context);
  Object.assign(context, createSessionViewCommit({
    identity: read('getCurrentSessionViewIdentity()'),
    read: read('readCurrentSessionViewState()'),
    apply: (patch) => vm.runInContext('applySessionViewPatch', context)(patch),
    normalizeModel: (value) => vm.runInContext('normalizeSessionModelState', context)(value),
    messagesRevision: read('_sessionViewMessagesRevision'),
    inputRequestsRevision: read('_sessionViewInputRequestsRevision'),
    switchEpoch: read('_switchEpoch'),
    generation: read('_sessionViewGeneration'),
    runtimeId: read('normalizeSessionViewRuntimeId(currentRuntimeAgentId)'),
    modelRuntimeId: read('_sessionViewModelRuntimeId'),
  }));
}
