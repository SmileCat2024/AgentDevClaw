// ESM 装载入口：P2「debug」批次（debug-preflight / debug-mcp）。
//
// 保留边界（R4，debug-logs 整文件保持 classic 唯一实现，**不进本入口**）：
// 日志面板的 render 入口（renderLogsPanel）与 onOpen 入口（loadLogs）由
// app-ui.js 的 registerFeaturePanel('logs') 闭包持有；该面板在注册表里带 order
// （可自定义），rail 按钮在首屏同步链（app-main 顶层 applyLanguage →
// renderCurrentMainView → syncRailButtons）就生成并可见，该点击不受认证闸保护，
// 早于 deferred ESM 求值——入口移入模块后，classic 相点击会抛 ReferenceError
// （面板空开）。处置同 todo-plan 先例（p2-w2-4 头注）：整文件保持 classic，
// 等 app-ui 面板注册与 rail 时序联合迁移后转换。不得以 typeof 守卫、隐藏按钮、
// 延后监听或 ready 队列规避。
//
// 因此 debug-logs 的 classic 标签必须留在 index.html；debug-mcp 的 safePrettyJson
// 经 window.safePrettyJson 取那份唯一实现（不 import、不复制第二份）。classic
// 标签全部先于 deferred ESM 执行，故 mcp 的 render 时点恒可用。
//
// 迁入本入口的两个模块（原 classic 标签序 441 → 442，二者无互相依赖）：
//   1. debug-preflight —— 装配预检面板（状态私有，渲染时才取数）。
//   2. debug-mcp      —— MCP 面板（状态经 debugPanel 成对读写）。
//
// 顶层副作用（R4）：两处 ESM 相注册——debug-preflight 的 data-action 接线
// （debug-mcp 无动作注册）与两个域的兼容桥（defineKey / claim）。这两个面板首屏
// 不存在可达入口：preflight 注册元数据既无 icon 也无 order（rail 不建按钮），
// mcp 无 order（rail-customize 挂 rail-custom-hidden 强制屏蔽），且都没有程序化
// 打开方；classic 相关闭包只持有引用、不执行。故不存在「classic 相点击 → 桥键
// 未定义」的窗口，不引入 ready 队列或额外守卫。
//
// 装载接线（index.html / p2-entry.js 属入口 owner）：
//   1. 删除 index.html 中 debug-preflight.js / debug-mcp.js 两条 classic 标签，
//      **保留 debug-logs.js 那条**（440）；
//   2. 在 p2-entry.js 的批次入口段追加
//        import './p2-debug-small-bootstrap.js';
//   3. frontend-script-tags-gate 的 MODULE_ENTRY_IMPORTS 无需新增条目
//      （p2-entry.js 已登记，本文件经它进入 ESM 图）。
import './debug-preflight.js';
import './debug-mcp.js';
