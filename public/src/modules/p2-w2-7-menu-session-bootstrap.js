// ESM 装载入口：P2 批次 W2-7「菜单与会话列表」。
//
// 本入口的职责只是让本批三个模块被求值，**不承诺 import 书写顺序等于求值顺序**：
// 原生 ESM 的求值顺序由模块图的依赖边决定（post-order DFS），存在静态循环时更不是
// 「按声明顺序」；原先 index.html 的 classic 标签序同样只是加载顺序，不是执行图。
// 可依赖的只是本批三模块**没有顶层求值依赖**：各自顶层仅注册 KernelState 桥键 /
// action-dispatcher 动作并定义函数，读取的都已是 classic 相就绪的
// window.KernelState 与 app-core 的 createP2Bootstrap*Host，批内模块之间只在调用时
// 取用对方导出。因此把它们放进同一入口即可，不需要也不应依赖彼此的执行先后：
//   - session-list-render.js  会话列表渲染域（依赖 session-ui / time-format-host /
//                             workspace-blocks / assembly-data / model-preset-cache /
//                             session-reference-picker / ph-thread-history 等）
//   - session-menu-decls.js   会话菜单声明面（sessionOps 事实 + APP 声明项）
//   - ctx-menu-items.js       菜单项声明表与动作分发（依赖前两者 + 侧栏操作域）
//
// 跨批图事实（不在本批改动面，仅记录，避免把加载序当成执行承诺）：public/src 当前
// 唯一的静态循环是 assembly-actions ↔ assembly-data ↔ feature-config ↔
// fw-config-panel ↔ workspace-blocks（本批经 workspace-blocks / assembly-data 进入
// 该 SCC）。SCC 内的求值顺序由依赖图遍历决定，模块间只在调用时取用导出、无顶层
// 求值依赖，因此不构成执行顺序约束。
//
// 未转换（本批 R1/R4 + 共享 owner 触线，见交付报告）：context-menu.js 与
// ctx-menu-handlers.js 保持唯一 classic 实现。原因是 app-core.js 顶层的
// contextMenu*（6 键：contextMenuAgentId / contextMenuAgentMode /
// contextMenuCompactAction / contextMenuProjectAgentId / contextMenuProjectId /
// contextMenuFeatureRepoPackageId）是 classic 词法绑定，既未上 KernelState 桥、
// app-core 的 bootstrap host 面（createP2Bootstrap*Host）也未提供读写适配；
// 该文件对是这 6 键的完整读写方（打开/关闭 + 各菜单动作 handler），伪写 window
// 或改 app-core 共享 owner 均越界。收敛条件：contextMenu* 状态进 bootstrap host
// （或随渲染入口域迁 ESM）后，两文件一并转 ESM 并改 import 本批导出。
//
// 说明：各模块的 classic 兼容面（仍被 classic 消费方裸读的函数）由各文件末尾的
// KernelState.defineKey/claim 提供，逐键消费证据与注销条件见各文件头注释。
import './session-list-render.js';
import './session-menu-decls.js';
import './ctx-menu-items.js';
