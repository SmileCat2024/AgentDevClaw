// ESM 装载入口：P2 批次 W2-11「调试总览与功能深面板」。
//
// 本批次最终形态（R4 返修后）：
//   - debug-overview.js       → 本入口装载（ESM，5 桥键 / 1 域认领）
//   - debug-features-hooks.js → 保持 classic 唯一实现，**不由本入口装载**
//
// 为什么拆开：hooks / inspector 两个 rail 按钮在 classic 相（app-main 顶层
// applyLanguage → syncRailButtons）就已生成、可见、可点击，点击发生在模块求值前
// 会抛 ReferenceError；debug-features-hooks 的 render 入口与其闭合依赖（空态 /
// 分组 / 卡片 / 详情弹窗 / 技能阅读页）互相缠绕，无法合理拆分，因此整文件保
// classic（见该文件头注）。debug-overview 的 workspace / monitor 面板注册元数据
// 没有 `order`，rail-customize 强制隐藏按钮，入口只在面板打开或 boot 之后的详情
// 动作里触达，classic 相零读写，因此保留 ESM。
//
// 顶层求值面（R4 审计结论）：debug-overview 转 ESM 后顶层语句只有
//   - KernelState.defineKey / claim（renderStructurePanel / renderMonitorPanel /
//     openFeatureDetails / closeFeatureDetails / openRepositoryPackageDetails
//     五键 + debug-overview 域认领；closeRepositoryPackageDetails 的桥已注销，
//     只剩命名导出）
//   - window.ClawFW.actions.registerMany（data-action 接线）
//   - 模块级常量（lifecycleDocs 与词表）
// 全部在 deferred ESM 相执行，位于全部 classic 脚本之后、DOMContentLoaded 之前；
// 这些键在 classic 相与首屏同步链上没有读写点。
//
// 装载接线（index.html 与 p2-entry.js 属入口 owner，本批不自行接线）：
//   1. 删除 index.html 中 debug-overview.js 的 classic 标签；
//      debug-features-hooks.js 的 classic 标签必须保留（它是唯一实现）。
//   2. 在 p2-entry.js 的批次入口段追加
//        import './p2-w2-11-debug-deep-bootstrap.js'; // 第二波 11：调试总览面板
//   3. frontend-script-tags-gate 的 MODULE_ENTRY_IMPORTS 无需新增条目
//      （p2-entry.js 已登记，本文件经它进入 ESM 图）。
//
// 撤除：P3 index.html 收敛到 module 入口 + 悬置域后，本文件随批次清单合并删除。
import './debug-overview.js';
