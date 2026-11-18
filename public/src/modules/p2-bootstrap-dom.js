/**
 * P2 bootstrap 消费接口适配 —— DOM 引用（P4 T1 起只是转发壳）。
 *
 * 状态 owner 已迁入 [dom-refs.js](dom-refs.js)：37 个 index.html 静态元素引用由
 * 该模块在求值期查询并冻结导出，本文件只保留原 import 路径（20+ 消费方
 * 与测试按此路径取用），不再经 `window.createP2BootstrapDomHost()` 转发——
 * classic 工厂已随 app-core 的 DOM 引用区一并删除，避免同一批引用出现第二份
 * 翻译层。
 *
 * 值的只读语义：domRefs 是 Object.freeze 的模块常量，向属性赋值在 ESM strict
 * 下抛 TypeError，与 classic 顶层 const 只读一致。
 *
 * 消费方（P2/P4 转换后 import）：chat-viewport / chat-scroll / chat-renderer /
 * chat-row-visibility / lazy-tool-content / persistent-input / input-render /
 * input-helpers / chat-context-bar / chat-nav-timeline / debug-panel-host /
 * debug-logs / todo-plan / ctx-menu-handlers / context-menu /
 * session-list-render / workspace-docset / workspace-actions / theme-lang /
 * sidebar-render / app-ui 等。
 *
 * 撤除：消费方全部改从 dom-refs.js 取用后即可删除本文件（纯路径别名，无逻辑）。
 */
export { domRefs } from './dom-refs.js';
