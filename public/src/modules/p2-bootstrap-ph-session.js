/**
 * P2 bootstrap 消费接口适配 —— 编程小助手会话列表 UI 状态。
 *
 * classic 唯一实现：public/src/app-core.js 的 createP2BootstrapPhSessionHost()。
 * 排序偏好 / 检索词 / 检索防抖句柄成对提供 get/set；savedPhTabState 是只读
 * 引用（classic 侧按 tabGroup 键就地改写，不整体替换）。
 *
 * 消费方（P2 转换后 import）：ph-session-list / ph-project-actions /
 * session-list-render / ph-search-locate / ph-session-move / session-ui /
 * app-ui。
 *
 * 撤除（P3）：以上消费方全部迁移、ph 会话列表状态 owner 迁入 ESM 后，删除本
 * 模块与 classic 工厂。
 */
export const phSessionUi = window.createP2BootstrapPhSessionHost();
