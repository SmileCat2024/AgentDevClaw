import { createRuntimeViewCache } from './runtime-view-cache.js';

// The classic adapter only exposes lexical state and still-classic operations.
// Navigation remains synchronous; no additional readiness promise is introduced.
const cache = createRuntimeViewCache(window.createRuntimeViewCacheHost());
export const { saveCurrentRuntimeToCache, restoreRuntimeFromCache, clearAgentRuntimeCache } = cache;

window.KernelState.defineKey('runtime-view-cache', 'saveCurrentRuntimeToCache', saveCurrentRuntimeToCache);
window.KernelState.defineKey('runtime-view-cache', 'restoreRuntimeFromCache', restoreRuntimeFromCache);
window.KernelState.defineKey('runtime-view-cache', 'clearAgentRuntimeCache', clearAgentRuntimeCache);
window.KernelState.claim('runtime-view-cache', {
  get: (key) => cache[key],
  set: (key, value) => { cache[key] = value; },
});
