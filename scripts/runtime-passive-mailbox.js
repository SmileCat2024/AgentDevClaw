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
 * @param {string} [ctx.viewerOrigin] - full origin override (test injection)
 * @param {number|string} [ctx.viewerPort] - loopback port fallback (host injects
 *   the resolved ViewerWorker port; not an address decision)
 * @param {typeof fetch} [ctx.fetchImpl]
 */
export function createPassiveMailboxLoop(ctx) {
  const pollIntervalMs = Number.isFinite(ctx.pollIntervalMs) && ctx.pollIntervalMs > 0
    ? ctx.pollIntervalMs
    : PASSIVE_MAILBOX_POLL_INTERVAL_MS;
  // runtime → 平台 HTTP 面寻址（ADR-0037 决策 3）：AGENTDEV_VIEWER_ORIGIN
  // 是宿主/部署注入的完整 origin（容器/远程时 runtime 与平台不在同一网络
  // 命名空间）；未注入时回退本机回环 + 端口。托管本地 runtime 由宿主剥
  // 离该 env（childProcessEnv），固定走回环——不消费平台面向外部 runtime
  // 的 origin 配置。
  const viewerUrl = ctx.viewerOrigin
    ?? process.env.AGENTDEV_VIEWER_ORIGIN
    ?? `http://127.0.0.1:${ctx.viewerPort ?? (process.env.AGENTDEV_VIEWER_PORT || '2026')}`;
  // 内部 token 存在时随请求携带 Bearer：回环模式服务端不校验（行为不变），
  // 非回环监听启用后直接生效——与框架 react-loop dequeue 同一口径。
  const internalToken = process.env.PROTOCLAW_INTERNAL_TOKEN;
  const fetchImpl = typeof ctx.fetchImpl === 'function' ? ctx.fetchImpl : fetch;

  async function dequeueInput(agentId) {
    // Thread commands use a durable claim that remains in Viewer until the
    // Agent snapshot is saved and CallArbiter acknowledges the exact lease.
    const identity = ctx.agent?.getRuntimeInputIdentity?.();
    if (identity?.threadId && Number.isInteger(identity.headGeneration)) {
      const claim = await fetchImpl(
        `${viewerUrl}/api/agents/${encodeURIComponent(agentId)}/command-input/claim`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
          },
        },
      );
      if (claim.status === 200 && claim.ok) {
        const data = await claim.json();
        if (data?.input?.inputLease) return data.input;
        throw new Error('Viewer returned a command claim without a durable input lease');
      }
      if (!claim.ok && claim.status !== 204 && claim.status !== 404) {
        throw new Error(`Command input claim failed: ${claim.status}`);
      }
    }

    const res = await fetchImpl(
      `${viewerUrl}/api/agents/${encodeURIComponent(agentId)}/dequeue-input`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.input || null;
  }

  async function acknowledgeInput(agentId, receipt) {
    const res = await fetchImpl(
      `${viewerUrl}/api/agents/${encodeURIComponent(agentId)}/command-input/ack`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { Authorization: `Bearer ${internalToken}` } : {}),
        },
        body: JSON.stringify({ receipt }),
      },
    );
    if (!res.ok) throw new Error(`Command input acknowledgement failed: ${res.status}`);
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

      const receipt = input.inputLease;
      if (receipt && typeof ctx.agent?.getContext === 'function') {
        const existing = ctx.agent.getContext()?.getAll?.() || [];
        if (existing.some((message) => message.inputReceipt?.commandId === receipt.commandId
          && message.inputReceipt?.threadId === receipt.threadId
          && message.inputReceipt?.headGeneration === receipt.headGeneration)) {
          // Snapshot persisted the command but the prior ack was lost: acknowledge
          // the same durable fact without adding or executing the user message again.
          await acknowledgeInput(agentId, receipt);
          ctx.callArbiter.enqueue({ source: 'thread-receipt-resume', text: '', kind: 'resume' });
          continue;
        }
      }

      const entry = ctx.callArbiter.enqueue({
        source: typeof input.source === 'string' && input.source ? input.source : 'queued-input',
        ...(typeof input.sourceRef === 'string' && input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(receipt ? { inputReceipt: receipt, acknowledgeInputReceipt: (identity) => acknowledgeInput(agentId, identity) } : {}),
        text: input.text,
        ...(input.kind === 'reminder' ? { kind: 'reminder' } : {}),
        ...(Array.isArray(input.images) && input.images.length > 0 ? { images: input.images } : {}),
        ...(Array.isArray(input.capabilityActivations) && input.capabilityActivations.length > 0
          ? { capabilityActivations: input.capabilityActivations.filter((a) => typeof a === 'string') }
          : {}),
        ...(input.metadata && typeof input.metadata === 'object' && Object.keys(input.metadata).length > 0
          ? { metadata: input.metadata }
          : {}),
      });
      // Serial consumption: don't poll again until this envelope settles.
      await ctx.callArbiter.waitForCompletion(entry.id);
    }
  }

  return { run };
}
