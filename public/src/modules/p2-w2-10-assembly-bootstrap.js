// ESM 装载入口：P2 第二波批次 10「装配工作台与表面块」。
//
// 本文件只声明 6 个模块的入口顺序；**实际求值顺序由 ESM 依赖图的深度优先后序
// 决定**，不是下面 import 语句的书写顺序。按当前依赖边实测（import 边 DFS 后序）：
//
//   fw-config-panel → assembly-actions → workspace-blocks → assembly-data
//   → feature-config → p2-w2-10-workspace-docset
//
// 其中前 5 个模块构成**一个强连通分量（SCC）**：它们是函数级互环
// （assembly-data ↔ workspace-blocks ↔ assembly-actions ↔ fw-config-panel，
// 且 feature-config 同时 import assembly-data / assembly-actions /
// workspace-blocks / fw-config-panel）。环安全的前提是这些模块顶层只做
// 「函数声明 / 字面量常量 / 桥键注册 / 动作注册」，求值期不读对方绑定——
// 函数声明在实例化阶段即已提升可用，因此无 TDZ，也不产生重复求值。
// p2-w2-10-workspace-docset 不在环内（只被 import，不反向 import）。
//
// 保留 classic 的两个文件（不属于本入口）：
//   - workspace-docset.js：同步首屏 `updateProjectDocsetChrome` 唯一 classic 实现
//     （见该文件头注释）；
//   - app-ui / app-core 等消费方：仍是 classic，按 index.html 的标签序加载。
//
// 接线（由主助手验收时执行）：删除这 6 个文件的 classic 标签，在
// workspace-blocks 原标签位置插入 `<script type="module" src="./src/modules/p2-w2-10-assembly-bootstrap.js"></script>`，
// 并把该入口登记进 frontend-script-tags-gate 的 MODULE_ENTRIES。
import './feature-config.js';
import './p2-w2-10-workspace-docset.js';
import './workspace-blocks.js';
import './assembly-data.js';
import './fw-config-panel.js';
import './assembly-actions.js';
