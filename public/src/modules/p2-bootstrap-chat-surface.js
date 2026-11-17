/**
 * P2 bootstrap 消费接口适配 —— 聊天表面状态。
 *
 * classic 唯一实现：public/src/app-core.js 的
 * createP2BootstrapChatSurfaceHost()。状态 owner 仍是 app-core 的顶层声明
 * （跟随滚动偏好、视口观察/结算句柄、过程可见性开关与 localStorage 键名），
 * 本模块不持有副本，读写实时转发。
 *
 * 只读属性（无 setter）：CHAT_PROCESS_VISIBILITY_KEY（常量）。
 * 其余属性成对提供 get/set；写入就是原 classic 赋值，不附加任何持久化副作用
 * （例如过程可见性仍由调用方自行 saveChatProcessVisibility）。
 *
 * 消费方（P2 转换后 import）：chat-viewport / chat-scroll / chat-renderer /
 * chat-row-visibility / lazy-tool-content / input-helpers / chat-context-bar /
 * input-render / runtime-status / app-main。
 *
 * 注：followLatestEnabled 另经 createRuntimeViewCacheHost 供 runtime-view-cache
 * ESM 使用；两处都是同一 classic 声明的转发，不构成双存储。
 *
 * 撤除（P3）：以上消费方全部迁移、视口/过程可见性域状态迁入 ESM owner 后，
 * 删除本模块与 classic 工厂。
 */
export const chatSurface = window.createP2BootstrapChatSurfaceHost();
