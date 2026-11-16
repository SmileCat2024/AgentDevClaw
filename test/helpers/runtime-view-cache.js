import { createRuntimeViewCache } from '../../public/src/modules/runtime-view-cache.js';

/** Mount the real ESM implementation on a classic VM's production adapter. */
export function installRuntimeViewCache(context) {
  const cache = createRuntimeViewCache(context.createRuntimeViewCacheHost());
  Object.assign(context, cache);
  return cache;
}
