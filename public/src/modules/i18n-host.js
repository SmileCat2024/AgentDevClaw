/**
 * i18n-host.js —— i18n 域的桥宿主（P4 T1 原料层）。
 *
 * 实现是 ESM 的 [../i18n.js](../i18n.js)（字典 + `createTranslator` + 生产绑定 `t`）。
 * 本文件只做桥注册，因此可以安全地由 kernel-entry 在模块相装载：
 *
 *   - `defineKey('i18n', 't', t)`：尚未迁移的 classic 消费方（app-ui / app-core /
 *     theme-lang / 各 sidebar / chat 模块）继续裸读 `t`，语义与迁移前一致；
 *   - `claim('i18n', ...)`：认领后 classic 写方（测试里的 `t = ...` 覆盖）经 setter
 *     转发进本域 state，读方拿到的是最新值。
 *
 * 收敛条件：classic 消费方全部转为 `import { t } from '../i18n.js'` 后删除本文件，
 * 并注销 `t` 桥键（消费面 grep 归零为准）。
 */
import { t } from '../i18n.js';

const bridgeState = { t };

window.KernelState.defineKey('i18n', 't', bridgeState.t);
window.KernelState.claim('i18n', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});
