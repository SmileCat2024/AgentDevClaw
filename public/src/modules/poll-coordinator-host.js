import { createPollCoordinator } from './poll-coordinator.js';

const coordinator = createPollCoordinator(window.createPollCoordinatorHost());
export const { poll, schedulePoll } = coordinator;
window.KernelState.defineKey('poll-coordinator', 'poll', poll);
window.KernelState.defineKey('poll-coordinator', 'schedulePoll', schedulePoll);
window.KernelState.claim('poll-coordinator', {
  get: (key) => coordinator[key],
  set: (key, value) => { coordinator[key] = value; },
});
