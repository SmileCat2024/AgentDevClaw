/**
 * CallArbiter — single entry point for agent.onCall().
 *
 * Guarantees that only one onCall() is active at a time per runtime.
 * All sources (user input, dispatch, IM) must enqueue envelopes here
 * instead of calling agent.onCall() directly.
 *
 * Extracted from scripts/run-prebuilt-agent.js to enable direct unit testing.
 */

import { defineStateMachine, reduce } from '@agentdevjs/core';

import { CONTINUATION_BUDGET } from './shared/constants.js';

/**
 * Envelope 状态转换表（ADR-0021 阶段 1）：envelope.status 的唯一求值来源。
 *
 * 词汇 queued / running / completed / failed / cancelled，后三者为终态。
 * `enqueued` 不设转换行——envelope 在构造前不存在，entry 字面量
 * `status: 'queued'` 是初始状态而非转换。
 *
 * 外壳策略（与 WorkThread 的 no-op 外壳不同，ADR-0021 决策 3）：reduce
 * 返回 unhandled / rejected 即 throw——未知事件或非法 from 是 bug，显式
 * 暴露。transitioned 携带的 lifecycleEvent 本期不消费（CallArbiter 无
 * 落盘事件日志，后续 inspection 通道再接）。
 */
const envelopeMachine = defineStateMachine({
  id: 'call-arbiter-envelope',
  statusField: 'status',
  states: {
    queued: {},
    running: {},
    completed: { terminal: true },
    failed: { terminal: true },
    cancelled: { terminal: true },
  },
  transitions: [
    { event: 'started', from: ['queued'], to: 'running' },
    { event: 'completed', from: ['running'], to: 'completed' },
    { event: 'failed', from: ['running'], to: 'failed' },
    // from '*' = 全部非终态（queued | running）；终态由内核先行拦截
    { event: 'cancelled', from: '*', to: 'cancelled' },
  ],
});

/**
 * 对 envelope 求值一次状态转换；非 transitioned 即 throw（显式暴露 bug）。
 * event 名与终态词汇对齐：outcome 观察分支直接以 outcome.status 作为事件名。
 */
function applyEnvelopeEvent(envelope, event) {
  const result = reduce(envelopeMachine, envelope, { type: event });
  if (result.type !== 'transitioned') {
    const detail = result.type === 'rejected' ? ` (reason=${result.reason})` : '';
    throw new Error(
      `[CallArbiter] envelope ${envelope.id} state machine ${result.type}${detail}: ` +
      `event "${event}" not applicable from status "${envelope.status}"`,
    );
  }
}

export class CallArbiter {
  /**
   * @param {object} agentInstance — must have async onCall(text)
   */
  constructor(agentInstance) {
    this._agent = agentInstance;
    this._queue = [];
    this._active = false;
    this._activeEnvelope = null;
    // Interrupt events targeting the active envelope (C3): arbiter-owned
    // queue — interruptActive() never mutates the envelope; _runEnvelope
    // closes it via _drainInterrupts() at the checkpoint positions.
    this._interruptEvents = [];
    this._status = 'idle'; // idle | queued | running
    this._listeners = { callStarted: [], callFinished: [] };
    // Completion trackers: envelopeId → resolve callback
    this._completionCallbacks = new Map();
    this._terminalEnvelopes = new Map();

    // ── Continuation support ──
    // Session save callback for checkpoint/rollback barriers.
    // Set via `arbiter.sessionSaveFn = async () => { ... }`.
    this.sessionSaveFn = null;

    // Continuation budget limits (per envelope).
    this.continuationBudget = { ...CONTINUATION_BUDGET };
  }

  /**
   * Enqueue a call envelope and kick the processing loop.
   *
   * @param {{ id?: string, source: string, sourceRef?: string, text: string, kind?: 'user' | 'reminder', images?: Array<{base64?:string,mediaType?:string,source?:string}>, capabilityActivations?: string[], metadata?: Record<string, unknown> }} envelope
   *   metadata 为随消息流动的自由元数据（user-turn 契约），只随首段传给
   *   onCall 并最终到达 CallStartContext.metadata（框架只透传不解释）。
   *   kind='reminder' 表示机器通报唤醒的 call，触发消息落为带 source 的
   *   system 消息而非 user 消息。
   * @returns {object} The envelope with assigned id and status
   */
  enqueue(envelope) {
    const hasImages = Array.isArray(envelope.images) && envelope.images.length > 0;

    const entry = {
      id: envelope.id || `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: envelope.source || 'unknown',
      sourceRef: envelope.sourceRef || '',
      text: envelope.text,
      ...(envelope.kind === 'reminder' ? { kind: 'reminder' } : {}),
      status: 'queued',
      createdAt: Date.now(),
      result: null,
      error: null,
      ...(Array.isArray(envelope.images) && envelope.images.length > 0 ? { images: envelope.images } : {}),
      ...(Array.isArray(envelope.capabilityActivations) && envelope.capabilityActivations.length > 0
        ? { capabilityActivations: envelope.capabilityActivations }
        : {}),
      ...(envelope.metadata && typeof envelope.metadata === 'object' && Object.keys(envelope.metadata).length > 0
        ? { metadata: envelope.metadata }
        : {}),
    };
    this._queue.push(entry);
    this._status = 'queued';
    console.log(`[CallArbiter] enqueued ${entry.id} (source=${entry.source}, queue=${this._queue.length}${hasImages ? `, images=${envelope.images.length}` : ''}${this._active ? ', waiting-for-active' : ''})`);
    this._kick();
    return entry;
  }

  /**
   * Drain all pending supplements (kept for backward compatibility —
   * the supplement mechanism has been removed; queued-input now flows
   * through the HTTP dequeue path in react-loop).
   * @returns {Array} Always empty
   */
  drainSupplements() {
    return [];
  }

  /**
   * Register a lifecycle event listener.
   * @param {'callStarted'|'callFinished'} event
   * @param {function} fn
   */
  on(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event].push(fn);
    }
  }

  /**
   * Wait for a specific envelope to complete (status = completed or failed).
   * Returns a promise that resolves with the finished envelope.
   *
   * @param {string} envelopeId
   * @returns {Promise<object>}
   */
  waitForCompletion(envelopeId) {
    const terminal = this._terminalEnvelopes.get(envelopeId);
    if (terminal) {
      this._terminalEnvelopes.delete(envelopeId);
      return Promise.resolve(terminal);
    }
    return new Promise((resolve) => {
      this._completionCallbacks.set(envelopeId, resolve);
    });
  }

  /** Get current arbiter status */
  getStatus() {
    return {
      status: this._status,
      queueLength: this._queue.length,
      activeEnvelopeId: this._activeEnvelope?.id || null,
    };
  }

  clearQueued(reason = 'cancelled by interrupt') {
    const removed = this._queue.splice(0, this._queue.length);
    for (const envelope of removed) {
      applyEnvelopeEvent(envelope, 'cancelled');
      envelope.error = reason;
      const cb = this._completionCallbacks.get(envelope.id);
      if (cb) {
        this._completionCallbacks.delete(envelope.id);
        cb(envelope);
      }
    }
    this._status = this._active ? 'running' : 'idle';
    return removed.length;
  }

  /**
   * Interrupt the active logical envelope in addition to clearing AgentDev's
   * current step. This closes the gap where agent.interrupt() ends one onCall
   * segment but the arbiter immediately launches its continuation.
   *
   * C3: the interrupt is recorded as an arbiter-level event — the envelope
   * itself is not mutated here (single-writer: all envelope mutations live in
   * the _runEnvelope loop, which drains the queue via _drainInterrupts() at
   * its checkpoint positions). clearQueued() keeps its synchronous sweep
   * semantics. Returns { active, cleared } synchronously as before.
   */
  interruptActive(reason = 'cancelled by interrupt', { clearQueue = true } = {}) {
    const envelope = this._activeEnvelope;
    if (envelope) {
      this._interruptEvents.push({ target: envelope, reason });
    }
    const cleared = clearQueue ? this.clearQueued(reason) : 0;
    return { active: Boolean(envelope), cleared };
  }

  // -- Internal --

  /**
   * Drain all queued inputs from ViewerWorker and enqueue them as new envelopes.
   * Called after each envelope completes, as a safety net for messages that
   * arrived during the call but weren't consumed by react-loop's step-boundary
   * or post-completion queue checks (e.g., maxTurns reached, call errored).
   */
  async _drainViewerQueuedInputs() {
    if (!this._agent?.agentId) return;
    const viewerPort = process.env.AGENTDEV_VIEWER_PORT || '2026';
    const viewerUrl = `http://127.0.0.1:${viewerPort}`;
    let count = 0;

    while (true) {
      try {
        const res = await fetch(
          `${viewerUrl}/api/agents/${encodeURIComponent(this._agent.agentId)}/dequeue-input`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        );
        if (!res.ok) break;
        const data = await res.json();
        if (!data.input) break;

        this.enqueue({
          // source 透传原始来源（reminder 落地为 system 消息时它就是
          // Message.source）；无 source 的项沿用邮箱兜底标识
          source: typeof data.input.source === 'string' && data.input.source ? data.input.source : 'queued-input',
          // 输入身份（ADR-0031 步骤一）：安全网转正的排队项保留 sourceRef，
          // 其执行随新 envelope 的 turn 事件可被关联回原提交
          ...(typeof data.input.sourceRef === 'string' && data.input.sourceRef
            ? { sourceRef: data.input.sourceRef }
            : {}),
          text: data.input.text,
          ...(data.input.kind === 'reminder' ? { kind: 'reminder' } : {}),
          ...(Array.isArray(data.input.images) && data.input.images.length > 0
            ? { images: data.input.images }
            : {}),
          ...(Array.isArray(data.input.capabilityActivations) && data.input.capabilityActivations.length > 0
            ? { capabilityActivations: data.input.capabilityActivations }
            : {}),
          ...(data.input.metadata && typeof data.input.metadata === 'object' && Object.keys(data.input.metadata).length > 0
            ? { metadata: data.input.metadata }
            : {}),
        });
        count++;
      } catch {
        break;
      }
    }

    if (count > 0) {
      console.log(`[CallArbiter] drained ${count} leftover queued input(s) after envelope completion`);
    }
  }

  _emit(event, envelope) {
    for (const fn of this._listeners[event] || []) {
      try { fn(envelope); } catch (err) {
        console.error(`[CallArbiter] ${event} listener error:`, err);
      }
    }
  }

  _kick() {
    if (this._active || this._queue.length === 0) return;
    // Dequeue and run
    this._active = true;
    this._activeEnvelope = this._queue.shift();
    this._status = 'running';

    const envelope = this._activeEnvelope;
    applyEnvelopeEvent(envelope, 'started');

    // Track continuation counters for this envelope
    envelope._segmentCount = 0;
    envelope._checkpointCount = 0;
    envelope._rollbackCount = 0;

    console.log(`[CallArbiter] executing ${envelope.id} (source=${envelope.source})`);
    this._emit('callStarted', envelope);

    // Run asynchronously so enqueue() returns immediately
    this._runEnvelope(envelope)
      .catch((err) => {
        applyEnvelopeEvent(envelope, 'failed');
        envelope.error = err instanceof Error ? err.message : String(err);
        console.error(`[CallArbiter] envelope ${envelope.id} failed:`, err);
      })
      .finally(() => {
        if (envelope.status === 'running') {
          // _runEnvelope completed without setting status (normal completion)
          applyEnvelopeEvent(envelope, 'completed');
        }
        this._active = false;

        this._status = this._queue.length > 0 ? 'queued' : 'idle';
        console.log(`[CallArbiter] finished ${envelope.id} (status=${envelope.status}, segments=${envelope._segmentCount || 0}, remaining=${this._queue.length})`);
        this._emit('callFinished', envelope);
        // Resolve any waitForCompletion() promises for this envelope
        const cb = this._completionCallbacks.get(envelope.id);
        if (cb) {
          this._completionCallbacks.delete(envelope.id);
          cb(envelope);
        }
        this._activeEnvelope = null;
        // Drain any queued inputs that weren't consumed during the call
        // (e.g., a call errored before the step-boundary queue check could run).
        // React-loop handles the common case (natural completion); this is a
        // safety net for edge cases.
        this._drainViewerQueuedInputs()
          .catch(() => {})
          .finally(() => this._kick());
      });
  }

  /**
   * Execute a logical envelope, which may consist of multiple sequential
   * onCall segments connected by checkpoint/rollback continuation requests.
   *
   * Each segment is a complete, non-recursive onCall().  Between segments,
   * the arbiter applies a barrier (checkpoint commit or rollback restore)
   * and then starts the next segment with an internal continuation input.
   *
   * The envelope is only "done" when a segment completes without registering
   * a continuation request, or when the continuation budget is exhausted.
   */
  async _runEnvelope(envelope) {
    let input = envelope.text;

    while (true) {
      if (this._drainInterrupts(envelope)) return;

      // ── Budget enforcement ──
      envelope._segmentCount += 1;
      if (envelope._segmentCount > this.continuationBudget.maxSegments) {
        throw new Error(`Continuation budget exhausted: maxSegments=${this.continuationBudget.maxSegments} reached for envelope ${envelope.id}`);
      }

      // ── Execute one onCall segment ──
      // capabilityActivations / metadata 只随首段携带：后续段复用已消费的上下文。
      // 原始输入身份（kind/source/sourceRef）也只属于首段；失败重试段显式使用
      // kind='resume'，让框架不追加新消息，直接凭现有上下文续跑。
      // sourceRef 随 CallTurnOptions 进框架，供 turn 事件关联原始提交。
      const activations = envelope._segmentCount === 1 ? envelope.capabilityActivations : undefined;
      const turnMetadata = envelope._segmentCount === 1 ? envelope.metadata : undefined;
      const isResume = envelope._resume === true;
      const turnOptions = {
        ...(envelope._segmentCount === 1 && envelope.kind === 'reminder' ? { kind: 'reminder' } : {}),
        ...(envelope._segmentCount === 1 && envelope.source ? { source: envelope.source } : {}),
        ...(envelope._segmentCount === 1 && envelope.sourceRef ? { sourceRef: envelope.sourceRef } : {}),
        ...(isResume ? { kind: 'resume' } : {}),
      };
      envelope._resume = false;
      const result = await this._agent.onCall(input, envelope.images, activations, turnMetadata,
        Object.keys(turnOptions).length > 0 ? turnOptions : undefined);
      envelope.result = typeof result === 'string' ? result : '';

      // ── Observe the structured call outcome ──
      // onCall() does not throw for in-call terminal states (model request
      // failure, user interrupt, step limit reached). The structured
      // CallOutcome from the framework is the authoritative terminal fact;
      // record it on the envelope instead of assuming completion whenever
      // onCall() returns without throwing.
      const outcome = typeof this._agent.getLastCallOutcome === 'function'
        ? this._agent.getLastCallOutcome()
        : null;
      if (outcome) {
        // 跨段合并（ADR-0031 步骤一）：每段 onCall 的 outcome 会覆盖本对象。
        // consumedSourceRefs 跨段累积（去重）——已消费身份是历史事实，不随段
        // 更替丢失。pendingWakeups 以当前段事实为准：框架只在仍有待唤醒工作
        // 时携带该字段，新段不带 = 当前无 pending，终态不得继承先前段的
        // 过时快照（一度 suspended 不等于永远 pending）。
        const priorConsumed = Array.isArray(envelope.outcome?.consumedSourceRefs)
          ? envelope.outcome.consumedSourceRefs
          : [];
        const mergedConsumed = [...priorConsumed];
        if (Array.isArray(outcome.consumedSourceRefs)) {
          for (const ref of outcome.consumedSourceRefs) {
            if (!mergedConsumed.includes(ref)) mergedConsumed.push(ref);
          }
        }
        envelope.outcome = {
          status: outcome.status,
          reason: outcome.reason,
          steps: outcome.steps,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.model ? { model: outcome.model } : {}),
          // 输入身份透传（ADR-0031 步骤一）：sourceRef 关联回触发提交，
          // consumedSourceRefs 是本回合 busy 排队消费的输入身份列表
          ...(outcome.sourceRef ? { sourceRef: outcome.sourceRef } : {}),
          ...(mergedConsumed.length > 0 ? { consumedSourceRefs: mergedConsumed } : {}),
          ...(Array.isArray(outcome.pendingWakeups) && outcome.pendingWakeups.length > 0
            ? { pendingWakeups: outcome.pendingWakeups }
            : {}),
        };
      }

      // AgentDev's abort and onCall completion are intentionally asynchronous.
      // Re-check the logical envelope before observing/starting continuation.
      if (this._drainInterrupts(envelope)) return;

      if (outcome && (outcome.status === 'failed' || outcome.status === 'cancelled')) {
        // Terminal segment state that did not throw: discard any continuation
        // registered just before termination so it cannot leak into a later
        // envelope (mirrors the guard in _drainInterrupts).
        if (typeof this._agent.consumeContinuationRequest === 'function') {
          try { this._agent.consumeContinuationRequest(); } catch {}
        }
        // Network failures may be retried by the session API retry policy.
        // Step limits and output-budget errors are never recovered here.
        if (outcome.status === 'failed') {
          const shouldResume = this._requestForcedContinuationInput(outcome);
          if (shouldResume) {
            console.log(`[CallArbiter] force continuation after ${outcome.reason} (envelope=${envelope.id})`);
            // Retry the existing transcript without adding a synthetic user prompt.
            input = '';
            envelope._resume = true;
            continue;
          }
        }
        applyEnvelopeEvent(envelope, outcome.status);
        envelope.error = outcome.error?.message || envelope.error || `call terminated: ${outcome.reason}`;
        return;
      }

      // ── Check for continuation request ──
      const continuation = typeof this._agent.consumeContinuationRequest === 'function'
        ? this._agent.consumeContinuationRequest()
        : null;

      if (!continuation) {
        // Normal completion — no continuation requested
        applyEnvelopeEvent(envelope, 'completed');
        return;
      }

      console.log(`[CallArbiter] continuation request: kind=${continuation.kind}, checkpointId=${continuation.checkpointId} (envelope=${envelope.id})`);

      // ── Apply continuation barrier ──
      if (continuation.kind === 'checkpoint') {
        envelope._checkpointCount += 1;
        if (envelope._checkpointCount > this.continuationBudget.maxCheckpoints) {
          throw new Error(`Continuation budget exhausted: maxCheckpoints=${this.continuationBudget.maxCheckpoints} reached for envelope ${envelope.id}`);
        }

        await this._checkpointBarrier(continuation, envelope);
        if (this._drainInterrupts(envelope)) return;
        this._injectContinuationSystemMessage('checkpoint', continuation);
        input = this._buildCheckpointContinuationInput(continuation);

      } else if (continuation.kind === 'rollback') {
        envelope._rollbackCount += 1;
        if (envelope._rollbackCount > this.continuationBudget.maxRollbacks) {
          throw new Error(`Continuation budget exhausted: maxRollbacks=${this.continuationBudget.maxRollbacks} reached for envelope ${envelope.id}`);
        }

        await this._rollbackBarrier(continuation, envelope);
        if (this._drainInterrupts(envelope)) return;
        this._injectContinuationSystemMessage('rollback', continuation);
        input = this._buildRollbackContinuationInput(continuation);
      }
    }
  }

  /**
   * Ask the session force-continuation Feature whether this failed Call is
   * host-recoverable, and if so return the continuation input. Each recovery
   * is gated by the network policy and shared retry budget.
   * Step limits and non-network errors remain terminal.
   */
  _requestForcedContinuationInput(outcome) {
    const forceContinuation = this._agent?.features?.get?.('force-continuation');
    if (!forceContinuation) return null;
    if (outcome.reason === 'error' && outcome.error?.retryable === true
      && typeof forceContinuation.requestApiErrorContinuation === 'function') {
      return forceContinuation.requestApiErrorContinuation(outcome);
    }
    return null;
  }

  /**
   * Drain the arbiter-level interrupt queue for one envelope (C3).
   *
   * Only events targeting `envelope` are honored; unmatched entries are
   * late interrupts whose target envelope already closed (or was replaced)
   * — silently dropped, not thrown at the state machine. Multiple events
   * for the same envelope resolve to the LAST reason (equivalent to the
   * old flag semantics where each interruptActive() call overwrote
   * envelope.error). The whole queue is emptied on every drain: a target
   * that didn't match can never become active again.
   */
  _drainInterrupts(envelope) {
    if (this._interruptEvents.length === 0) return false;
    let reason;
    let matched = false;
    for (const event of this._interruptEvents) {
      if (event.target === envelope) {
        matched = true;
        reason = event.reason;
      }
    }
    this._interruptEvents.length = 0;
    if (!matched) return false;
    // A continuation may have been registered just before abort completed.
    // Consume and discard it so it cannot leak into a later envelope.
    if (typeof this._agent.consumeContinuationRequest === 'function') {
      try { this._agent.consumeContinuationRequest(); } catch {}
    }
    applyEnvelopeEvent(envelope, 'cancelled');
    envelope.error = reason || envelope.error || 'cancelled by interrupt';
    return true;
  }

  /**
   * Checkpoint barrier: capture named runtime snapshot and persist session.
   */
  async _checkpointBarrier(continuation, envelope) {
    const checkpointId = continuation.checkpointId;

    if (typeof this._agent.createNamedCheckpoint === 'function') {
      // Single-checkpoint model: clear existing checkpoints before creating a new one
      if (typeof this._agent.clearNamedCheckpoints === 'function') {
        this._agent.clearNamedCheckpoints();
      }
      await this._agent.createNamedCheckpoint(checkpointId);
      console.log(`[CallArbiter] checkpoint committed: ${checkpointId} (envelope=${envelope.id})`);
    }

    // Save session and wait for completion
    if (this.sessionSaveFn) {
      await this.sessionSaveFn();
    }
  }

  /**
   * Rollback barrier: restore named checkpoint and persist session.
   */
  async _rollbackBarrier(continuation, envelope) {
    const checkpointId = continuation.checkpointId;

    if (typeof this._agent.rollbackToNamedCheckpoint === 'function') {
      await this._agent.rollbackToNamedCheckpoint(checkpointId);
      console.log(`[CallArbiter] rollback completed: ${checkpointId} (envelope=${envelope.id})`);
    }

    // Save session and wait for completion
    if (this.sessionSaveFn) {
      await this.sessionSaveFn();
    }
  }

  /**
   * Inject a system message before the continuation user input.
   *
   * The system message carries the detailed continuation context (checkpoint
   * info or rollback summary + side-effects warning), while the user message
   * that onCall will add afterwards is kept short and auto-generated in tone.
   */
  _injectContinuationSystemMessage(kind, continuation) {
    const ctx = typeof this._agent.getContext === 'function'
      ? this._agent.getContext()
      : null;
    if (!ctx || typeof ctx.add !== 'function') return;

    if (kind === 'checkpoint') {
      const note = continuation.metadata?.note ? `\n备注: ${continuation.metadata.note}` : '';
      ctx.add({
        role: 'system',
        content: `检查点 "${continuation.checkpointId}" 已建立并提交。当前对话上下文已保存。${note}\n\n后续视需要可调用 rollback_to_checkpoint 回退到此处。`,
      });
    } else if (kind === 'rollback') {
      ctx.add({
        role: 'system',
        content: [
          `会话已回退到检查点 "${continuation.checkpointId}"。`,
          '',
          '以下是被回退会话的摘要：',
          continuation.summary,
          '',
          '注意：回退仅恢复对话上下文和部分工具状态。外部执行（文件写入、命令执行、API 调用等）不会被撤销——请验证所修改的外部资源的真实状态。',
        ].join('\n'),
      });
    }
  }

  /**
   * Build the continuation user input for a checkpoint segment.
   * Kept short — the detailed context is in the preceding system message.
   */
  _buildCheckpointContinuationInput(_continuation) {
    return '[本条消息由系统自动发送] 检查点已生效。请从此处继续执行当前任务——可以自由探索，如果方向不对可随时回退。';
  }

  /**
   * Build the continuation user input for a rollback segment.
   * Kept short — the detailed context (summary, warnings) is in the
   * preceding system message.
   */
  _buildRollbackContinuationInput(_continuation) {
    return '[本条消息由系统自动发送] 刚才会话发生了回退，以上为相关信息。请从恢复的检查点继续原始任务。';
  }
}
