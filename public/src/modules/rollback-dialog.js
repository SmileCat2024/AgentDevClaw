/**
 * rollback-dialog.js — 部分压缩 / 回退对话框域：状态桥注册薄壳（classic → ESM，P4 T2 批次）
 * 从 app-main.js 拆出（Phase A-6），2026-07-03 拆出。
 *
 * 本文件仍然只做一件事：注册本域状态键的 window 访问器（defineKey），供仍未
 * 迁移的 classic 消费方裸读写。对话框装配、运行期回退编排与 toast 文案在
 * `rollback-dialog-runtime.js`（ESM）；部分压缩记账与状态 owner 在
 * `p2-w2-3b-rollback-domain.js`（ESM，claim 时吸收 / 接管这些键）。
 *
 * 注册相位（R1/R2 审计结论）：本批把注册从 classic 相移到 ESM 相，判据是
 * **classic 相没有任何触达点**——P4 时序切换提交后首屏渲染链已由 `boot.js`
 * 在模块相触发，上述键的全部读写都在函数体内（渲染 / 切换会话时相），没有
 * 顶层读；因此模块相注册与 classic 相注册语义等价。若 claim 先发生（p2-entry
 * 的 owner 先求值），`defineKey` 按 kernel-state 的认领后补注册路径把初值直接
 * 推入域状态，仍是同一份状态、无双存储。
 *
 * 桥键（domain `rollback-dialog`；状态 owner 与 claim 在 p2-w2-3b-rollback-domain.js）：
 *   _partialCompactInFlight     ← input-composer.js（级 4 compacting）、
 *                                 app-main.js（切换 runtime / 新 lease 后清理）
 *   _partialCompactRuntimeId    ← input-composer.js（级 4 runtime 归属）、app-main.js
 *   _compactTimerInterval       ← input-composer.js（detachTransientInputContent 清理）
 *   _rollbackDialogOpen         ← input-composer.js（级 3 frozen 判定）
 *   `_partialCompactContextKey` 本批注销：唯一消费方 input-render.js 已迁 ESM 并改为
 *   import 域状态（消费面 grep 归零证据见批次报告），不再需要 window 访问器。
 *   注销条件（其余四键）：input-composer / app-main 迁 ESM 后改为 import。
 *
 * 行为键（注册行在 p2-w2-3b-rollback-domain.js，本批不改该文件）：
 *   readPartialCompactStartedAt / writePartialCompactStartedAt ← 本批之后零 classic
 *     消费方（input-render 改为 import；rollback-dialog-runtime 早已 import）—
 *     注册行在本批清单外，注销交由主助手处理（归零证据见批次报告）。
 *   clearPartialCompactState ← app-main.js（仍 classic，注册继续有效）。
 */
window.KernelState.defineKey('rollback-dialog', '_partialCompactInFlight', false);
window.KernelState.defineKey('rollback-dialog', '_partialCompactRuntimeId', null);
window.KernelState.defineKey('rollback-dialog', '_compactTimerInterval', null);
window.KernelState.defineKey('rollback-dialog', '_rollbackDialogOpen', false);
