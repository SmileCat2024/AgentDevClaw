/**
 * ESM 绞杀者迁移兼容桥（P0.1）。
 *
 * 桥接期状态的唯一物理持有方是这里的哑存储 Map<domain:key, value>：
 * - classic 侧经 defineKey 把跨文件共享键注册成 window 访问器，
 *   未迁移消费方的裸标识符读写语义完全不变；
 * - ESM 域模块装载时经 claim(domain, impl) 接管该域全部已注册键，
 *   之后 classic 写方经 setter 转发进 ESM 状态，双向持续生效；
 * - 终局消费方归零后 delete window.<key> 撤桥（configurable: true 保证）。
 *
 * 语义契约由 test/kernel-bridge.test.js 钉住；机制规格见
 * docs/plans/2026-11-16-frontend-esm-strangler-migration.md「桥机制规格」。
 *
 * 桥债口径：访问器键本质仍是全局状态，必须显式统计（stats() 的
 * registeredKeys / claimedKeys）：P1 建立期审查并记录新增，消费方收敛期注销下降。口径独立于
 * .frontend-globals-baseline.json 的 state/behavior 两层台账，不玩口径游戏。
 */
(function () {
  'use strict';

  // fullKey = `${domain}:${key}` → 值。键被认领后从哑存储移除，真相源归 ESM 域模块。
  const store = new Map();
  const keyDomains = new Map(); // window 键名 → domain（注册清单：唯一性检测 + stats）
  const claimedDomains = new Set();
  const impls = new Map(); // domain → { get(key), set(key, value) }

  const isClaimed = (domain) => claimedDomains.has(domain);

  window.KernelState = {
    /**
     * 注册一个桥键：在 window 上定义访问器。同键重复注册抛错——桥键唯一
     * 注册制。唯一性按 window 键名（跨域全名）判定，而非 domain:key：
     * 哑存储虽按域隔离，window 属性名是全局命名空间，两个域注册同名键时
     * 后者的 defineProperty 会静默覆盖前者的访问器，造成读写分叉。
     */
    defineKey(domain, key, initialValue) {
      const existing = keyDomains.get(key);
      if (existing !== undefined) {
        throw new Error(
          `[KernelState] 桥键重复注册：${key}（已属域 ${existing}；桥键唯一注册制）`,
        );
      }
      keyDomains.set(key, domain);
      const fullKey = `${domain}:${key}`;
      if (isClaimed(domain)) {
        // 认领后补注册的键：初值直接落进域模块状态，访问器动态判定向 impl 转发。
        impls.get(domain).set(key, initialValue);
      } else {
        store.set(fullKey, initialValue);
      }
      Object.defineProperty(window, key, {
        get() {
          if (isClaimed(domain)) return impls.get(domain).get(key);
          return store.get(fullKey);
        },
        set(value) {
          if (isClaimed(domain)) {
            impls.get(domain).set(key, value);
            return;
          }
          store.set(fullKey, value);
        },
        configurable: true, // 终局撤桥（delete window.<key>）需要
        enumerable: false, // 与原顶层 let 一致：不进 for-in / Object.keys
      });
    },

    /**
     * ESM 域模块装载时接管该域全部已注册键（一次性，无 unclaim）。
     *
     * 初值语义（吸收式）：claim 时把哑存储现值一次性经 impl.set 推给域模块，
     * 所有权完整转移——此后哑存储不再是这些键的真相源。选择吸收而非
     * "impl.get 首调回读哑存储"，理由：impl.get(key) / impl.set(key, v)
     * 签名保持纯粹（不带隐式第二语义），域模块接管后自己就是唯一真相源，
     * 不会出现"getter 返回 undefined 时桥回退哑存储"这种与"状态真被清成
     * undefined"无法区分的含糊路径。
     */
    claim(domain, impl) {
      impls.set(domain, impl);
      claimedDomains.add(domain);
      for (const [key, keyDomain] of keyDomains) {
        if (keyDomain !== domain) continue;
        impl.set(key, store.get(`${domain}:${key}`));
        store.delete(`${domain}:${key}`);
      }
    },

    /** 桥债指标：registeredKeys = defineKey 注册总数；claimedKeys = 已被认领键总数。 */
    stats() {
      let claimedKeys = 0;
      for (const keyDomain of keyDomains.values()) {
        if (isClaimed(keyDomain)) claimedKeys += 1;
      }
      return { registeredKeys: keyDomains.size, claimedKeys };
    },
  };
})();
