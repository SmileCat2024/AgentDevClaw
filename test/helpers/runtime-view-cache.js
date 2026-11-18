import { createRuntimeViewCache } from '../../public/src/modules/runtime-view-cache.js';

/**
 * Mount the real ESM runtime-view-cache implementation on a classic VM's production adapter.
 *
 * app-core 自 P4 T5 起是 ESM：`createRuntimeViewCacheHost()` 在模块相才注册
 * （domain `app-core` 的桥键 / `__esmDomain.appCore` 的具名导出）。本 helper 在
 * classic 回调里就被调用，因此三个入口按需在**首次调用时**装配——那时模块图已经
 * 求值，宿主必然就绪；装配只发生一次（同一 host / 同一缓存容器）。
 *
 * 宿主来源优先 `__esmDomain.appCore`（与图内模块同一实例），其次沙箱上的桥键：
 * 两条路径都是同一份模块实现，不建副本。
 */
export function installRuntimeViewCache(context) {
  let cache = null;
  const ensure = () => {
    if (cache) return cache;
    const appCore = context.__esmDomain?.appCore;
    const factory = typeof appCore?.createRuntimeViewCacheHost === 'function'
      ? appCore.createRuntimeViewCacheHost
      : context.createRuntimeViewCacheHost;
    if (typeof factory !== 'function') {
      throw new Error('runtime-view-cache 夹具：app-core 的 createRuntimeViewCacheHost 尚未就绪（模块相之后才可用）');
    }
    cache = createRuntimeViewCache(factory());
    return cache;
  };
  const installed = {
    saveCurrentRuntimeToCache: (...args) => ensure().saveCurrentRuntimeToCache(...args),
    restoreRuntimeFromCache: (...args) => ensure().restoreRuntimeFromCache(...args),
    clearAgentRuntimeCache: (...args) => ensure().clearAgentRuntimeCache(...args),
  };
  Object.assign(context, installed);
  return installed;
}
