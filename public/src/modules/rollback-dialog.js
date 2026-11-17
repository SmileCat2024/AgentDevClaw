/**
 * rollback-dialog.js — 部分压缩 / 回退对话框域：classic 相同步注册薄壳
 * 从 app-main.js 拆出（Phase A-6），2026-07-03 拆出。
 *
 * 本文件现在**只做一件事**：在 classic 相原位注册本域五个状态键的 window
 * 访问器（defineKey）。对话框装配、运行期回退编排与 toast 文案已迁
 * `rollback-dialog-runtime.js`（ESM）；部分压缩记账与状态 owner 在
 * `p2-w2-3b-rollback-domain.js`（ESM，claim 时吸收本文件注册的真初值）。
 * 这里不新增加载期逻辑、不改变注册相位——原因见下方注释：首屏同步链在读这些键。
 *
 * 桥键（domain `rollback-dialog`；状态 owner 与 claim 在
 * p2-w2-3b-rollback-domain.js，本文件只保留 classic 相 defineKey 注册）:
 *   _partialCompactInFlight, _partialCompactRuntimeId, _partialCompactContextKey,
 *   _compactTimerInterval, _rollbackDialogOpen
 * 函数键（迁至 rollback-dialog-runtime.js，经 KernelState 桥键服务 classic 调用）:
 *   requestRollbackEdit ← chat-renderer 的 `chat.rollbackEdit` 分发动作
 * 已迁出的桥键（定义于 p2-w2-3b-rollback-domain.js，classic 消费方裸读）:
 *   readPartialCompactStartedAt / writePartialCompactStartedAt /
 *   clearPartialCompactState ← input-render.js / app-main.js
 */

// ESM 迁移（P2 W2-3b 建立，本批收尾）：本域状态的唯一 owner 是
// p2-w2-3b-rollback-domain.js。这里保留**classic 相注册**，依据是首屏同步链的
// 真实触达（app-main 顶层 applyLanguage → renderCurrentMainView →
// notifyInputSurfaceChanged → classic input-render 渲染入口 → input-composer 模式
// 判定 / 临时内容清理），该链在 deferred 模块执行之前就发生：
//   - `_rollbackDialogOpen`     ← input-render 冻结判定 + input-composer 级 3
//   - `_partialCompactInFlight` ← input-composer 级 4
//   - `_partialCompactRuntimeId`← input-composer 级 4 的 runtime 归属
//   - `_compactTimerInterval`   ← 首屏 hidden 分支 detachTransientInputContent
//     的清理路径（清 interval 并置 null）
// `_partialCompactContextKey` **不在首屏触达**（只被压缩卡分支读，需要 runtime
// 在场）；它仍留在同一注册块，是因为它与上述键同属压缩状态族、同一处声明，
// 不为单键另设相（避免顺手移相）。
// ESM owner 装载时 claim 吸收现值，之后 classic 裸读写经访问器转发，无双存储。
window.KernelState.defineKey('rollback-dialog', '_partialCompactInFlight', false);
window.KernelState.defineKey('rollback-dialog', '_partialCompactRuntimeId', null);
window.KernelState.defineKey('rollback-dialog', '_partialCompactContextKey', null);
window.KernelState.defineKey('rollback-dialog', '_compactTimerInterval', null);

window.KernelState.defineKey('rollback-dialog', '_rollbackDialogOpen', false);
