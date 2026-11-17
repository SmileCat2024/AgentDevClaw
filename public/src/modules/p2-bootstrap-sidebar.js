/**
 * P2 bootstrap 消费接口适配 —— 侧栏交互态与渲染去重签名。
 *
 * classic 唯一实现（两个 owner 文件，各自持有自己的词法状态）：
 * - public/src/app-core.js 的 createP2BootstrapSidebarHost() → 重启中的 runtime
 *   集合（const Set，按引用交出，变异走既有 .add/.delete）与菜单期间抑制全量
 *   重建标志（get/set）；
 * - public/src/modules/sidebar-render.js 的
 *   createP2BootstrapSidebarRenderHost() → lastAgentListRenderSignature
 *   （get/set，清空即强制下次 renderAgentList 重建）。
 *
 * 消费方（P2 转换后 import）：ctx-menu-handlers / ctx-menu-items / app-main /
 * sidebar-render（sidebarUi）；sidebar-pin-color / session-mutation /
 * sidebar-operations / thread-store / sidebar-render（sidebarRender）。
 *
 * 撤除（P3）：以上消费方全部迁移、侧栏交互态与渲染去重状态迁入 ESM owner 后，
 * 删除本模块与两个 classic 工厂。
 */
export const sidebarUi = window.createP2BootstrapSidebarHost();
export const sidebarRender = window.createP2BootstrapSidebarRenderHost();
