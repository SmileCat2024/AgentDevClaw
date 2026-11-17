// ESM 装载入口：P2 批次 W2-6「侧栏操作与会话状态」。
//
// 静态 import 的求值顺序（深度优先、按声明顺序）就是本批的执行顺序。它取代的是
// index.html 原来的 classic 标签序（标签顺序：sidebar-operations → sidebar-layout →
// sidebar-pin-color → session-ui → external-runtime → session-mutation），两者顺序
// 不同且无需一致——本批模块之间只有 import 图依赖，没有求值期的加载序依赖：
//   1. sidebar-operations —— 侧栏操作状态机 / 诊断队列 / 会话快照合并（无批内前置）
//   2. external-runtime   —— 外部 runtime 关闭重启；直接 import sidebar-operations
//   3. session-ui         —— 会话列表 UI 助手与卡片缓存；直接 import sidebar-operations
//   4. sidebar-pin-color  —— pin 颜色交互；只依赖 locale 与渲染签名适配面
//   5. session-mutation   —— 会话替换状态机；import 前四者（依赖图决定）
//
// 未转换：sidebar-layout.js 保持唯一 classic 实现（本批 R4/R1 触线，见交付报告）——
// app-main 顶层 applyLanguage() 同步调用 renderAgentList()，后者在
// classic sidebar-render.js 里以无守卫的 window.ClawSidebarLayout.render(...) 取用
// 该模块的 window 协议对象；deferred module 执行晚于 classic 解析相，无法在首屏
// 同步渲染前提供该对象。收敛条件：sidebar-render 迁移（改 import）后本模块补齐
// import './sidebar-layout.js'。
//
// 说明：各模块的 classic 兼容面（仍被 classic 消费方裸读的函数与状态）由各文件
// 末尾的 KernelState.defineKey/claim 提供，逐键消费证据与注销条件见各文件头注释。
import './sidebar-operations.js';
import './external-runtime.js';
import './session-ui.js';
import './sidebar-pin-color.js';
import './session-mutation.js';
