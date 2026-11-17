// ESM 装载入口：P2 第二波批次 4「标题时间线与快照呈现」。
//
// 静态 import 的求值顺序（深度优先、按声明顺序）就是本批的执行顺序，替代原先
// index.html 的 classic 标签序（template-engine 462 → overview-data 464 →
// auto-title 511 → message-timeline 536）：
//   1. template-engine —— 工具模板解析/渲染、代码高亮与截断展开（依赖模板映射、
//                        会话/渲染状态、会话切换引导标志）
//   2. overview-data  —— overview/hook inspector 快照规范化与提交
//   3. auto-title     —— 会话视图工具（消息比较/选择告警）+ 已硬屏蔽的历史标题实现
//   4. message-timeline —— 用户消息时间分隔线（纯函数）
//
// 各模块的兼容桥（KernelState defineKey/claim）在模块自身文件尾部注册；这里只
// 负责装载顺序，不再引入额外状态或初始化副作用。
//
// 同步残余（R1，三模块均保留唯一 classic 实现，不进本入口）：
// - todo-plan.js：计划面板 render 回调由 app-ui 的 registerFeaturePanel 闭包持有，
//   而 rail 按钮在首屏同步 `renderCurrentMainView → syncRailButtons` 就建立并可点击；
//   该点击不受 auth 闸保护，deferred 模块尚未执行时桥键不存在 → ReferenceError。
//   因此计划渲染/折叠/面板策略整文件保持 classic，等联合迁移完整首屏依赖图。
// - agent-data-loader.js：clearRecap 需写 recap-hint.js 顶层词法
//   （_currentRecapText / _recapPendingTrigger），该文件既未上桥也不在本批授权范围；
//   等待 recap 状态 owner 交付后再转换，不建副本、不造桥。
import './template-engine.js';
import './overview-data.js';
import './auto-title.js';
import './message-timeline.js';
