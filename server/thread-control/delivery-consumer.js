/**
 * Thread Delivery Consumer — R6：投递触发点的统一消费面
 *
 * Thread Inbox 的三个回访点（applySessionSuccession 推进后 / runtime
 * ready 补投 / gateway append 后的即时尝试）不再各自裸调
 * deliverPendingCommands，统一经本 consumer 消费，获得：
 *   - 退避：投递失败（attempted > delivered，retryable break 场景）后
 *     线程级冷却一个窗口，防触发点风暴下的重复失败投递。挡板 / hold /
 *     closed 的 gated no-op（attempted === 0）是等待不是失败，不退避。
 *     advance 换代（force）是新权威事实——head/runtime 已更换，不受上一
 *     轮失败退避约束，applySessionSuccession 的投递走 force 通道。
 *   - 滞留水位告警：pending 指令最老滞留超过阈值时告警一次；同一
 *     head 代际只告警一次（head 换代或积压清空后重置）。
 *   - FIFO：同线程指令严格按入箱顺序投出（deliverPendingCommands 的
 *     数组顺序，由测试固定）。
 *
 * 退避与告警去抖都是进程内内存语义：重启丢失只是多投一次 / 多告警
 * 一次，不影响正确性——落盘状态仍以 commands 数组为唯一真相。
 */

export function createDeliveryConsumer(core, {
  backoffMs = 2000,
  staleWarnMs = 10 * 60 * 1000,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const backoffUntil = new Map();
  const warnedStale = new Set();

  function staleKey(threadId, headSessionId) {
    return `${threadId}:${headSessionId}`;
  }

  async function checkStaleWatermark(threadId) {
    let record;
    try {
      record = await core.getThread(threadId);
    } catch {
      return; // 水位检查失败不阻断投递主流程
    }
    if (!record) return;

    const pending = (record.commands || []).filter((c) => c?.status === 'pending');
    const key = staleKey(threadId, record.headSessionId);
    if (pending.length === 0) {
      warnedStale.delete(key);
      return;
    }
    const oldest = pending.reduce((min, c) => Math.min(min, Number(c.createdAt) || Infinity), Infinity);
    if (!Number.isFinite(oldest)) return;
    const age = now() - oldest;
    if (age >= staleWarnMs && !warnedStale.has(key)) {
      warnedStale.add(key);
      logger.warn(
        `[thread-delivery] stale watermark: ${pending.length} command(s) pending over ${staleWarnMs}ms `
        + `on thread ${threadId} (head=${record.headSessionId}, oldest=${age}ms)`,
      );
    }
  }

  async function consume(threadId, { force = false } = {}) {
    const nowMs = now();
    if (!force) {
      const until = backoffUntil.get(threadId) || 0;
      if (nowMs < until) {
        return { attempted: 0, delivered: 0, reason: 'delivery_backoff', retryInMs: until - nowMs };
      }
    }

    const result = await core.deliverPendingCommands(threadId);
    const attempted = Number(result?.attempted) || 0;
    const delivered = Number(result?.delivered) || 0;
    if (attempted > 0 && delivered < attempted) {
      backoffUntil.set(threadId, nowMs + backoffMs);
    } else if (delivered > 0) {
      backoffUntil.delete(threadId);
    }

    await checkStaleWatermark(threadId);
    return result;
  }

  return { consume };
}
