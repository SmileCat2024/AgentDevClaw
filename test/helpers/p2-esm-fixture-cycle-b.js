/**
 * p2-esm-fixture-cycle-b.js — p2-esm-case 的 fixture：静态循环的 B 端 + 独立模块状态。
 *
 * `bCount` 用来区分「已加载的 B 被复用」与「整图重新实例化」：loadModuleOnce
 * 只刷新入口时，B 的计数会跨入口重载延续（见 test/p2-esm-case.test.js 回归）。
 */
import { readA } from './p2-esm-fixture-cycle-a.js';

let bCount = 0;

export function bumpCount() {
  bCount += 1;
  return bCount;
}

export function readCount() {
  return `b:${readA()}:${bCount}`;
}

/** 传进来的 readA 是否就是 B 静态 import 到的那个绑定。 */
export function linksTo(candidate) {
  return candidate === readA;
}
