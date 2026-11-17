/**
 * P2 bootstrap 消费接口适配 —— 预制工作空间会话切换引导标志。
 *
 * classic 唯一实现：public/src/app-core.js 的
 * createP2BootstrapSessionSwitchHost()。templateWarmupToken 由 template-engine
 * 递增后与异步回调里的快照比较（读改写，成对 get/set）；prebuiltSwitch 在飞
 * 标志同形。
 *
 * 消费方（P2 转换后 import）：template-engine / workspace-actions / app-main。
 *
 * 撤除（P3）：以上消费方全部迁移、切换引导状态 owner 迁入 ESM 后，删除本模块
 * 与 classic 工厂。
 */
export const sessionSwitch = window.createP2BootstrapSessionSwitchHost();
