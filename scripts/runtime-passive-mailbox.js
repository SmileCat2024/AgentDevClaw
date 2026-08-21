/**
 * Passive Mailbox Loop — extracted from run-prebuilt-agent.js (passive branch).
 *
 * Agents without UserInputFeature run in "passive event mode": no input loop,
 * therefore no input lease is ever opened. External user-turns (thread
 * commands, CLI sends, chat composer) can only land in ViewerWorker's
 * per-session mailbox (queuedInputs). The framework consumes that mailbox
 * only while/after a call is in flight (react-loop step boundaries +
 * CallArbiter's post-envelope drain). When the runtime is idle, nothing
 * consumes it — the session hangs with the message staged forever.
 *
 * This loop wires the mailbox as one more external event source into the
 * CallArbiter, same as the dispatch / IM / group-chat bridges:
 *  - only dequeues when the arbiter is idle (busy-time messages belong to
 *    react-loop's in-call injection and the arbiter's safety-net drain);
 *  - consumes serially: waits for each envelope to finish before polling again;
 *  - transparently forwards the original source / sourceRef so thread
 *    commands keep their identity for delivery tracking.
 *
 * The factory receives a mutable context object (same pattern as
 * createIMBridge); all hooks are injectable for unit testing.
 */

import { setTimeout as sleep } from 'timers/promises';

export const PASSIVE_MAILBOX_POLL_INTERVAL_MS = 1000;

/**
 * @param {object} ctx - runtime context
 * @param {object|null} ctx.agent - agent instance; must expose agentId
 *   (viewerAgentId, available after withViewer)
 * @param {object|null} ctx.callArbiter - CallArbiter; must expose
 *   getStatus() / enqueue() / waitForCompletion()
 * @param {() => boolean} ctx.isDisposed - returns true once the session is removed
 * @param {number} [ctx.pollIntervalMs]
 * @param {number|string} [ctx.viewerPort]
 * @param {typeof fetch} [ctx.fetchImpl]
 */
export function createPassiveMailboxLoop(ctx) {
  const pollIntervalMs = Number.isFinite(ctx.pollIntervalMs) && ctx.pollIntervalMs > 0
    ? ctx.pollIntervalMs
    : PASSIVE_MAILBOX_POLL_INTERVAL_MS;
  const viewerUrl = `http://127.0.0.1:${ctx.viewerPort ?? (process.env.AGENTDEV_VIEWER_PORT || '2026')}`;
  const fetchImpl = typeof ctx.fetchImpl === 'function' ? ctx.fetchImpl : fetch;

  async function dequeueInput(agentId) {
    const res = await fetchImpl(
      `${viewerUrl}/api/agents/${encodeURIComponent(agentId)}/dequeue-input`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.input || null;
  }

  async function run() {
    while (!ctx.isDisposed()) {
      await sleep(pollIntervalMs);
      if (ctx.isDisposed()) break;

      const agentId = ctx.agent?.agentId;
      if (!agentId || !ctx.callArbiter) continue;

      // Idle-only consumption: while a call is in flight the mailbox belongs
      // to react-loop's step-boundary drain and the arbiter's safety net.
      if (ctx.callArbiter.getStatus().status !== 'idle') continue;

      let input = null;
      try {
        input = await dequeueInput(agentId);
      } catch {
        continue;
      }
      if (!input || typeof input.text !== 'string' || input.text.length === 0) continue;

      const entry = ctx.callArbiter.enqueue({
        source: typeof input.source === 'string' && input.source ? input.source : 'queued-input',
        ...(typeof input.sourceRef === 'string' && input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        text: input.text,
        ...(Array.isArray(input.images) && input.images.length > 0 ? { images: input.images } : {}),
      });
      // Serial consumption: don't poll again until this envelope settles.
      await ctx.callArbiter.waitForCompletion(entry.id);
    }
  }

  return { run };
}
