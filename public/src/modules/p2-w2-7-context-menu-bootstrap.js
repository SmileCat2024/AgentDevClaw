// ESM 装载入口：P2 批次 W2-7「菜单与会话列表」剩余的两文件（上下文菜单开关与动作）。
//
// 与 p2-w2-7-menu-session-bootstrap.js（同批前三模块）分开登记，因为这两文件的
// 求值有真实的顺序约束，不能塞进同一入口靠注释约定：
//   - context-menu.js       右键菜单开关与几何（8 个导出）；顶层只 import 两个
//                           bootstrap 适配面并注册 kernel-state 桥键，无 DOM/
//                           事件副作用；
//   - ctx-menu-handlers.js  13 个元素/文档/窗口监听 + 一个桥键（openAgentActions；
//                           newIdempotencyKey 不建桥，见该文件末尾的求值约束）；
//                           它 **import context-menu.js**，因此求值顺序由模块图
//                           依赖边保证（开关实现先于监听注册），不依赖入口内
//                           的书写顺序。
//
// 时序（R4）：本入口求值 = 普通（非 async）`<script type="module">` 的 deferred
// 执行相：document 解析完成之后、DOMContentLoaded 之前。接线必须是普通 module
// 标签（不能加 async），否则下面的顺序保证失效。真实启动链：
//   静态非 async ESM 执行完 → DOMContentLoaded → auth-client initialize()
//   （modules/auth-client.js 尾部 `document.addEventListener('DOMContentLoaded',
//   initialize)`）→ `window.__clawAuthReady` → app-main 尾部 boot
//   （`await window.__clawAuthReady; await startApplication()`）。
// 侧栏条目点击 / 菜单打开等入口全部在 boot 之后才可能发生，因此：
//   - context-menu.js 的桥键在此注册，早于任何消费方调用点（四个入口的消费
//     方均为事件回调或 boot 后才执行的宿主工厂，R1 零顶层调用）；
//   - ctx-menu-handlers.js 的 13 个监听在此注册，早于任何可派发它们的交互。
// 结论不是「没有同步 dispatch 所以用户不可触发」，而是模块求值本身排在
// DOMContentLoaded 之前、而用户可交互路径排在 boot 之后。
//
// index.html 接线（主助手）：删除
//   <script src="./src/modules/context-menu.js"></script>
//   <script src="./src/modules/ctx-menu-handlers.js"></script>
// 两条 classic 标签，并在两者原位之一以 <script type="module"> 引入本入口
// （登记进 frontend-script-tags-gate 的 MODULE_ENTRIES）。
import './context-menu.js';
import './ctx-menu-handlers.js';
