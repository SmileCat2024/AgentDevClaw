/**
 * p2-esm-fixture-cycle-a.js — p2-esm-case 的 fixture：静态循环的 A 端 + 模块级状态。
 *
 * 与 cycle-b 互相 import（真实 ESM 循环），用来钉住两件事：
 *   - case query 是「每 case 一个」而不是「每 import 一个」，循环仍解析到同
 *     一代实例（`bSeesThisInstance()` 为 true）；
 *   - 下一用例整图重新实例化（aCount 归零），而上一个用例的图仍保持自身状态。
 *
 * 不含任何浏览器全局：fixture 只验证加载器语义，不参与业务断言。
 */
import { readCount as readCycleBCount, bumpCount as bumpCycleBCount, linksTo } from './p2-esm-fixture-cycle-b.js';

export let aCount = 0;

export function bumpA() {
  aCount += 1;
  return aCount;
}

export function readA() {
  return aCount;
}

/** 经 B 读本实例状态：B 的 readA 绑定到哪一代 A，这里就返回哪一代的计数。 */
export function viaB() {
  return readCycleBCount();
}

export function bumpViaB() {
  return bumpCycleBCount();
}

/** B 的 readA 绑定是否就是本实例的 readA（循环闭合、未分裂成两代的证据）。 */
export function bSeesThisInstance() {
  return linksTo(readA);
}
