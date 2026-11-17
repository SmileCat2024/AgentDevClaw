/**
 * P2 bootstrap 消费接口适配 —— assembly 工作台 UI 状态。
 *
 * classic 唯一实现：public/src/app-core.js 的 createP2BootstrapAssemblyHost()。
 * 控制面板开合、草稿重渲染句柄、启动在飞标志、侧栏渐显句柄全部成对提供
 * get/set（定时器句柄按原值转发，调用方仍自行 clearTimeout）。
 *
 * 消费方（P2 转换后 import）：assembly-actions / assembly-data / chat-viewport /
 * app-ui。
 *
 * 撤除（P3）：以上消费方全部迁移、assembly UI 状态 owner 迁入 ESM 后，删除本
 * 模块与 classic 工厂。
 */
export const assemblyUi = window.createP2BootstrapAssemblyHost();
