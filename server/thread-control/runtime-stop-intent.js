/**
 * Runtime 退出与线程业务状态之间的语义边界。
 *
 * `runtime.stopped` 只说明执行载体已停止，不能单独证明用户放弃了当前工作。
 * 宿主整体关闭属于可恢复中断，必须保留 board=running；其他显式停止路径沿用
 * C1 的收敛语义。意外进程退出时 stopped 尚未置位，也保留 running。
 */

export const RUNTIME_STOP_REASON = Object.freeze({
  HOST_SHUTDOWN: 'host_shutdown',
});

/** 标注整机关闭意图，再停止 runtime 执行载体。 */
export function markRuntimeForHostShutdown(runtime) {
  if (!runtime || typeof runtime !== 'object') return false;
  runtime.stopReason = RUNTIME_STOP_REASON.HOST_SHUTDOWN;
  runtime.stopped = true;
  return true;
}

/** 只有显式停止且非整机关闭，才把活动线程收敛为空闲。 */
export function shouldConvergeThreadAfterRuntimeExit(runtime) {
  return runtime?.stopped === true
    && runtime.stopReason !== RUNTIME_STOP_REASON.HOST_SHUTDOWN;
}
