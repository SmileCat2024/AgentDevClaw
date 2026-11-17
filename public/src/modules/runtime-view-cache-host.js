import { createRuntimeViewCache } from './runtime-view-cache.js';

// The classic adapter only exposes lexical state and still-classic operations.
// Navigation remains synchronous; no additional readiness promise is introduced.
const cache = createRuntimeViewCache(window.createRuntimeViewCacheHost());
export const { saveCurrentRuntimeToCache, restoreRuntimeFromCache, clearAgentRuntimeCache } = cache;
