/**
 * P2 bootstrap 消费接口适配 —— 上下文菜单待执行目标。
 *
 * classic 唯一实现：public/src/app-core.js 的 createP2BootstrapContextMenuHost()。
 * 6 个 classic 顶层 let（contextMenuAgentId / contextMenuAgentMode /
 * contextMenuCompactAction / contextMenuProjectAgentId / contextMenuProjectId /
 * contextMenuFeatureRepoPackageId）就在该文件声明处持有，本模块只交出同一个
 * 读写转发面，不持有副本、不重跑初始化。
 *
 * 消费方（当前唯一读写方，均为 classic）：context-menu.js（打开时写入、关闭时
 * 清空）与 ctx-menu-handlers.js（各菜单动作 handler 读取后执行）。两者转 ESM
 * 时改 import 本模块导出，不再裸读 classic 全局词法；菜单 DOM 引用已由
 * p2-bootstrap-dom.js 的 domRefs 提供，不在本模块。
 *
 * 撤除（P3）：上述消费方全部迁移、这 6 个状态的 owner 移入 ESM 后，删除本模块
 * 与 classic 工厂；在此之前禁止把它当作状态真相源或另存副本。
 */
export const contextMenuUi = window.createP2BootstrapContextMenuHost();
