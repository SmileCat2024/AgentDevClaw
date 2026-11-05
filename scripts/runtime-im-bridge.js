/**
 * Runtime IPC 桥 — 从 run-prebuilt-agent.js 抽出（原 IM Bridge 的残余部分）
 *
 * ADR-0042 切片 E 之后，本模块只剩一件事：处理 runtime 级 IPC 控制消息。
 *
 * 原有的两项 IM 关注点已经迁走，不要再往这里加回来：
 *  - 结果镜像（dispatchIMCallFinish）→ 门户线路运行时（portal-lines.js 的
 *    轮次事件出站）。多线路并发下「镜像到唯一活跃渠道」本身不再成立。
 *  - 载体动态挂载（mountCarrierFeature / mountIMLineCarrierIfBound）→ 门户
 *    持有全部渠道连接。把 carrier feature 挂进「目标会话 runtime」的机制随
 *    线程寻址退役：线程换头会让 runtime 换代，平台连接不该跟着断。
 */

/**
 * @param {object} ctx - mutable runtime context
 * @param {object|null} ctx.agent - set during main()
 */
export function createRuntimeIPC(ctx) {
  /**
   * Handle an IPC message for this session.
   * Called by the central IPC dispatcher (not registered on process directly).
   */
  async function handleIPCMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'todo-control') {
      // 设置/取消"执行到此处"目标
      const todoFeature = ctx.agent?.features?.get?.('todo');
      if (todoFeature && typeof todoFeature.setInterruptTarget === 'function') {
        todoFeature.setInterruptTarget(msg.taskId || null);
      } else {
        console.warn('[IPC] Todo feature not found or does not support setInterruptTarget');
      }
    }
  }

  return { handleIPCMessage };
}
