/**
 * install-i18n.js — 把 i18n 的 `t` 装进测试沙箱（生产是 ESM + 桥键）。
 *
 * 生产侧 i18n 已是 ESM：`public/src/i18n.js` 提供真实字典与 `createTranslator`，
 * 桥键 `t` 由 `modules/i18n-host.js` 在模块相注册（defineKey + claim）。沙箱
 * 测试没有模块相，因此这里只装一个**普通值** `t`：
 *
 *   - 用真实 `createTranslator` 与真实字典，断言里的中英文文案仍由真实数据驱动，
 *     不在测试里复制文案；
 *   - 每次调用实时读沙箱 `currentLanguage`，语言切换后无需重建；
 *   - 装普通值而不是桥访问器：装载整张生产图的用例会真实执行 i18n-host 的
 *     defineKey，若沙箱先占了访问器就会撞上「桥键唯一注册制」而抛错。普通值可被
 *     defineKey 覆盖，语义与生产「classic 相先写入、模块相接管」一致；
 *   - 用例若先用 `t: ...` 覆盖桩播种（createFrontendSandbox 的 overrides），那个
 *     桩就是初值，不被真实字典顶掉。
 *
 * 调用前置：沙箱已建好（createFrontendSandbox 自动调用本 helper）。
 */
import { createTranslator } from '../../public/src/i18n.js';

const installed = new WeakSet();

/**
 * @param {object} context — 沙箱 window（classic 脚本与 currentLanguage 所在对象）
 * @returns {Function} 装进沙箱的 `t`
 */
export function installI18n(context) {
  if (installed.has(context)) return context.t;
  const seeded = Object.prototype.hasOwnProperty.call(context, 't') ? context.t : undefined;
  context.t = seeded || createTranslator(() => context.currentLanguage || 'zh');
  installed.add(context);
  return context.t;
}
