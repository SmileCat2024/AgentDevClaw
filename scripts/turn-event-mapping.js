/**
 * Envelope → thread turn event mapping（宿主策略层）
 *
 * 把 CallArbiter envelope 的终态映射为线程事件流的 turn.* 事件。
 * 这是 runtime 与线程层之间的唯一契约点，语义必须与单 session CLI
 * （session-events.ts：completed 才发 turn.completed）对齐，并叠加宿主策略：
 *
 * 1. status=completed 且 providerStopReason 属过滤/拒绝类（content_filter /
 *    refusal）时，框架会把空/残缺回复当作自然完成 —— 宿主必须把它改判为
 *    turn.failed（不可重试）：输出被供应商内容过滤拦截，不是正常结束。
 * 2. status=cancelled 是生命周期信号（guard 轮换 / 宿主中断），不是执行失败。
 * 3. 其余非 completed 状态为真实执行失败，带结构化 reason/category。
 *
 * ── turn 号契约（0-based，与 runtime 上报方 run-prebuilt-agent.js 对齐）──
 *
 * turn 号 = Agent._callIndex（session 级 0-based 计数，首个 turn 为 0）：
 * - turn.started：CallArbiter 在 _kick() 同步 emit callStarted，随后才异步
 *   执行 envelope（executeCall 内 _callIndex 递增），回调读到的 _callIndex
 *   尚未递增，故上报方报 `_callIndex + 1` 对齐本次 call 号。
 * - turn.completed：callFinished 在 envelope 完成后 emit，递增已发生，
 *   直接报 `_callIndex`。同一 turn 的 started / completed 同号。
 * - turn 号只在单 session 内单调；thread 接力/分支后新 session 从 0 重新
 *   计数，跨 runtime 不单调。消费方（ACP adapter 等）判新旧只能依赖
 *   eventId，不得比较 turn 号绝对值。
 */

/** 供应商"输出被拦截/拒绝"类 stop reason，映射为不可重试失败 */
const FILTER_STOP_REASONS = new Set(['content_filter', 'refusal']);

/**
 * @param {{ status?: string, error?: string, outcome?: {
 *   status?: string, reason?: string,
 *   error?: { message?: string, category?: string, retryable?: boolean },
 *   model?: { providerStopReason?: string | null },
 * } }} envelope CallArbiter 终态 envelope
 * @param {{ turn?: number | null, usage?: object | null }} [extra]
 * @returns {{ type: string, turn: number | null, usage?: object,
 *   error?: { message: string, reason: string, category: string, retryable?: boolean } }}
 */
export function mapEnvelopeToTurnEvent(envelope, { turn = null, usage = null } = {}) {
  const outcome = envelope?.outcome || null;
  const providerStopReason = outcome?.model?.providerStopReason || null;
  const turnNumber = Number.isInteger(turn) ? turn : null;

  if (envelope?.status === 'completed') {
    if (providerStopReason && FILTER_STOP_REASONS.has(providerStopReason)) {
      return {
        type: 'turn.failed',
        turn: turnNumber,
        error: {
          message: `model output blocked by provider filter (stop reason: ${providerStopReason})`,
          reason: providerStopReason,
          category: 'content_filter',
          retryable: false,
        },
      };
    }
    return {
      type: 'turn.completed',
      turn: turnNumber,
      ...(usage ? { usage } : {}),
    };
  }

  if (envelope?.status === 'cancelled') {
    return {
      type: 'turn.cancelled',
      turn: turnNumber,
      error: {
        message: envelope?.error || 'cancelled by interrupt',
        reason: outcome?.reason || 'cancelled',
        category: 'lifecycle',
      },
    };
  }

  return {
    type: 'turn.failed',
    turn: turnNumber,
    error: {
      message: envelope?.error || outcome?.error?.message || `call ${envelope?.status || 'failed'}`,
      reason: outcome?.reason || envelope?.status || 'failed',
      category: outcome?.error?.category || 'runtime',
      ...(typeof outcome?.error?.retryable === 'boolean' ? { retryable: outcome.error.retryable } : {}),
    },
  };
}
