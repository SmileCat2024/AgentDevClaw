import { createMessageProbe } from './message-probe.js';
import { computeSerializedBytes, createMessageMetrics } from './message-metrics.js';
import { createCommittedViewRenderer } from './committed-view-renderer.js';
import { currentMessages } from './session-view-storage.js';
import { isSessionViewTokenCurrent, commitSessionViewPatch } from './session-view-commit-host.js';

const probe = createMessageProbe({
  ...window.createMessageProbeHost(createCommittedViewRenderer, createMessageMetrics, computeSerializedBytes),
  messages: () => currentMessages,
  isCurrent: isSessionViewTokenCurrent,
  commit: commitSessionViewPatch,
});
export const { runMessagesProbeCycle } = probe;
window.KernelState.defineKey('message-probe', 'runMessagesProbeCycle', runMessagesProbeCycle);
window.KernelState.claim('message-probe', {
  get: (key) => probe[key],
  set: (key, value) => { probe[key] = value; },
});
