/**
 * Interjection mailbox re-post — extracted helper for run-prebuilt-agent's
 * input loop.
 *
 * Regression background (2026-11-05 插话时序 bug): the input loop holds an
 * armed text input lease whenever its session is idle. Calls started by
 * NON-lease sources (thread rotation continuations delivered as kind=
 * 'reminder', IM dispatch, scheduled reminders) do not consume that lease,
 * so it stays armed while a call runs. A user message submitted during the
 * call is then forwarded by ViewerWorker as the LEASE ANSWER
 * (delivery: 'input'), and the input loop turns it into a next-call
 * envelope serialized behind the active call (AgentBase call queueing) —
 * the message only lands after the call ends (integer next turn), while
 * later messages that fall through to the mailbox get injected mid-call
 * (fractional interjection turn). First-sent / last-landed FIFO inversion.
 *
 * Fix contract: when the CallArbiter is busy, the lease answer is re-posted
 * to the ViewerWorker mailbox instead of enqueueing an envelope, so the
 * message takes the designed mid-call injection path (react-loop
 * step-boundary drain with interjection checkpoint). This helper performs
 * that re-post with the same addressing and auth discipline as the passive
 * mailbox loop (loopback viewer + internal token).
 *
 * All hooks injectable for unit testing (same pattern as
 * runtime-passive-mailbox.js).
 */

/**
 * @typedef {object} MailboxPostResult
 * @property {boolean} ok viewer 邮箱是否已承接
 * @property {string} [delivery] viewer 响应的 delivery 形态（'queued' 期望；
 *   'input' 理论不可达，防御记录）
 * @property {number|string} [status] 失败时的诊断（HTTP status / 错误码）
 * @property {unknown} [error] 失败时的原始错误
 */

/**
 * 等待 CallArbiter 回到 idle（忙时不武装新的输入 lease）。
 *
 * 为什么必须等：输入循环在 lease 被应答后立刻重新武装 lease 的话，viewer
 * 侧的「lease 转交」路径（新 lease 武装时把邮箱队首转给它）会把刚回投的
 * 插话立刻转回 lease——应答→回投→再转交→再应答，形成毫秒级热循环，直到
 * 某个步边界 drain 恰好把消息从邮箱抢走才自愈。忙时插话的正确通道是邮箱
 * （react-loop 步边界注入 + arbiter 安全网），lease 是空闲会话的输入面；
 * 等回 idle 再武装，循环在源头上不存在。
 *
 * @param {object} args
 * @param {() => {status: string}} args.getStatus - CallArbiter.getStatus
 * @param {() => boolean} args.isCancelled - 取消条件（session disposed / loop 退役）
 * @param {number} [args.pollIntervalMs=200] - 轮询间隔
 * @param {(ms: number) => Promise<void>} [args.sleepImpl]
 * @returns {Promise<'idle'|'cancelled'>}
 */
export async function waitForArbiterIdle({
  getStatus,
  isCancelled,
  pollIntervalMs = 200,
  sleepImpl,
} = {}) {
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  while (true) {
    if (isCancelled && isCancelled()) return 'cancelled';
    let status;
    try {
      status = getStatus?.()?.status;
    } catch {
      status = null;
    }
    if (status === 'idle') return 'idle';
    await sleep(pollIntervalMs);
  }
}

/**
 * 把 lease 应答回投 viewer 邮箱（忙时插话的运行中注入路径）。
 *
 * @param {object} args
 * @param {string} args.agentId - viewer agentId（this.agent.agentId）
 * @param {object} args.turn - user-turn 载荷（text/source/sourceRef/images/
 *   capabilityActivations/metadata；字段已由调用方按 viewer 契约备好）
 * @param {number|string} [args.viewerPort] - 回环端口回退（宿主注入解析值）
 * @param {string} [args.viewerOrigin] - 完整 origin 覆盖（测试注入）
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<MailboxPostResult>} ok=true 表示 viewer 邮箱已承接
 */
export async function postUserTurnToViewerMailbox({
  agentId,
  turn,
  viewerOrigin,
  viewerPort,
  fetchImpl = fetch,
} = {}) {
  if (!agentId || typeof agentId !== 'string') {
    return { ok: false, status: 'missing_agent_id' };
  }
  // runtime → 平台 HTTP 面寻址（ADR-0037 决策 3），与 passive mailbox
  // loop / react-loop dequeue 同一口径：宿主注入 origin，否则本机回环。
  const origin = viewerOrigin
    ?? process.env.AGENTDEV_VIEWER_ORIGIN
    ?? `http://127.0.0.1:${viewerPort ?? (process.env.AGENTDEV_VIEWER_PORT || '2026')}`;
  const internalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
  try {
    const res = await fetchImpl(
      `${origin}/api/agents/${encodeURIComponent(agentId)}/user-turn`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
        },
        body: JSON.stringify(turn),
      },
    );
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    const data = await res.json().catch(() => null);
    if (data && data.success === true) {
      // 本循环在自身 lease 刚被消费、下一 lease 尚未武装的窗口内投递，
      // 期望 delivery='queued'。'input' 意味着有其他 lease 并发武装（防御
      // 分支）：消息已被租约承接，不丢，但时序修复不成立，如实上报。
      return { ok: true, delivery: data.delivery };
    }
    return { ok: false, status: 'viewer_rejected', error: data };
  } catch (error) {
    return { ok: false, error };
  }
}
