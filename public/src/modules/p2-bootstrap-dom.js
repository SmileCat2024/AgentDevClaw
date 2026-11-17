/**
 * P2 bootstrap 消费接口适配 —— DOM 引用。
 *
 * classic 唯一实现：public/src/app-core.js 的 createP2BootstrapDomHost()。
 * 值是加载期 document.getElementById 得到的 const 引用（元素从不替换），因此
 * 这里只读：没有 setter，向 domRefs 的属性赋值在 ESM strict 下抛 TypeError，
 * 与 classic 顶层 const 的只读语义一致。
 *
 * 消费方（P2 转换后 import）：chat-viewport / chat-scroll / chat-renderer /
 * chat-row-visibility / lazy-tool-content / persistent-input / input-render /
 * input-helpers / chat-context-bar / chat-nav-timeline / debug-panel-host /
 * debug-logs / todo-plan / ctx-menu-handlers / context-menu /
 * session-list-render / workspace-docset / workspace-actions / theme-lang /
 * sidebar-render / agent-snapshot-loader 等。
 *
 * 撤除（P3）：以上消费方全部迁移、DOM 引用 owner 移入 ESM 后，删除本模块与
 * classic 工厂；迁移期禁止在 ESM 侧另存元素引用副本。
 */
export const domRefs = window.createP2BootstrapDomHost();
