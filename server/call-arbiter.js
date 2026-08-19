/**
 * CallArbiter — single entry point for agent.onCall().
 *
 * Guarantees that only one onCall() is active at a time per runtime.
 * All sources (user input, dispatch, IM) must enqueue envelopes here
 * instead of calling agent.onCall() directly.
 *
 * Extracted from scripts/run-prebuilt-agent.js to enable direct unit testing.
 * The DebugHub dependency is injected via setDebugHubClass() so that the
 * module can be loaded and tested without the agentdev framework.
 */

// ── DebugHub injection ──
// run-prebuilt-agent.js calls setDebugHubClass(DebugHub) after import.
// When null (e.g. in tests), DebugHub-related calls are silently skipped.

import { CONTINUATION_BUDGET } from './shared/constants.js';

let _debugHubClass = null;

/**
 * Inject the DebugHub class (from agentdev) so CallArbiter can notify
 * the ViewerWorker about queued-input consumption.
 * @param {{ getInstance: () => any } | null} cls
 */
export function setDebugHubClass(cls) {
  _debugHubClass = cls;
}

/**
 * @returns {object|null} DebugHub singleton instance, or null if not configured.
 */
function getDebugHubInstance() {
  if (!_debugHubClass) return null;
  try {
    return _debugHubClass.getInstance();
  } catch {
    return null;
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
    * @param {{ id?: string, source: string, sourceRef?: string, text: string, images?: Array<{base64?:string,mediaType?:string,source?:string}> }} envelope
    * @returns {object} The envelope with assigned id and status
    */
  enqueue(envelope) {
    const contextGuard = this._agent?.contextGuard;
    if (contextGuard && typeof contextGuard.isBlocked === 'function' && contextGuard.isBlocked()) {
      const entry = {
        id: envelope.id || `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source: envelope.source || 'unknown',
        sourceRef: envelope.sourceRef || '',
        text: envelope.text,
        status: 'failed',
        createdAt: Date.now(),
        result: '',
        error: contextGuard.getBlockReason?.() || 'Session is blocked by the context guard.',
      };
      this._terminalEnvelopes.set(entry.id, entry);
      return entry;
    }
    const hasImages = Array.isArray(envelope.images) && envelope.images.length > 0;

    const entry = {
      id: envelope.id || `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: envelope.source || 'unknown',
      sourceRef: envelope.sourceRef || '',
      text: envelope.text,
      status: 'queued',
      createdAt: Date.now(),
      result: null,
      error: null,
      ...(Array.isArray(envelope.images) && envelope.images.length > 0 ? { images: envelope.images } : {}),
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
      envelope.status = 'cancelled';
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
   * Mark the active logical envelope as interrupted in addition to clearing
   * AgentDev's current step. This closes the gap where agent.interrupt() ends
   * one onCall segment but the arbiter immediately launches its continuation.
   */
  interruptActive(reason = 'cancelled by interrupt', { clearQueue = true } = {}) {
    const envelope = this._activeEnvelope;
    if (envelope) {
      envelope._interruptRequested = true;
      // @deprecated (2026-07-25) — set but never read; clearQueued() is called
      // immediately below instead. Pre-existing dead field; safe to remove.
      envelope._discardQueuedOnInterrupt = clearQueue === true;
      envelope.error = reason;
    }
    const cleared = clearQueue ? this.clearQueued(reason) : 0;
    return { active: Boolean(envelope), cleared };
  }

  blockQueued(reason = 'Session blocked by the context guard') {
    return this.clearQueued(reason);
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
          source: 'queued-input',
          text: data.input.text,
          ...(Array.isArray(data.input.images) && data.input.images.length > 0
            ? { images: data.input.images }
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
    envelope.status = 'running';

    // Track continuation counters for this envelope
    envelope._segmentCount = 0;
    envelope._checkpointCount = 0;
    envelope._rollbackCount = 0;

    // @deprecated (2026-07-25) — supplement mechanism removed; no new envelopes
    // are created with source='queued-input'. This call is harmless dead code.
    // Safe to remove in a future cleanup.
    const hub = getDebugHubInstance();
    if (envelope.source === 'queued-input' && envelope.sourceRef && hub && this._agent?.agentId) {
      try {
        hub.consumeQueuedInput(this._agent.agentId, envelope.sourceRef);
      } catch (error) {
        console.warn('[CallArbiter] consumeQueuedInput failed:', error);
      }
    }

    console.log(`[CallArbiter] executing ${envelope.id} (source=${envelope.source})`);
    this._emit('callStarted', envelope);

    // Run asynchronously so enqueue() returns immediately
    this._runEnvelope(envelope)
      .catch((err) => {
        envelope.status = 'failed';
        envelope.error = err instanceof Error ? err.message : String(err);
        console.error(`[CallArbiter] envelope ${envelope.id} failed:`, err);
      })
      .finally(() => {
        if (envelope.status === 'running') {
          // _runEnvelope completed without setting status (normal completion)
          envelope.status = 'completed';
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
        // (e.g., call hit maxTurns or errored before the step-boundary
        // queue check could run). React-loop already handles the common
        // case (natural completion); this is a safety net for edge cases.
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
      if (this._finishInterruptedEnvelope(envelope)) return;

      // ── Budget enforcement ──
      envelope._segmentCount += 1;
      if (envelope._segmentCount > this.continuationBudget.maxSegments) {
        throw new Error(`Continuation budget exhausted: maxSegments=${this.continuationBudget.maxSegments} reached for envelope ${envelope.id}`);
      }

      // ── Execute one onCall segment ──
      const result = await this._agent.onCall(input, envelope.images);
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
        envelope.outcome = {
          status: outcome.status,
          reason: outcome.reason,
          steps: outcome.steps,
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(outcome.model ? { model: outcome.model } : {}),
        };
      }

      // AgentDev's abort and onCall completion are intentionally asynchronous.
      // Re-check the logical envelope before observing/starting continuation.
      if (this._finishInterruptedEnvelope(envelope)) return;

      if (outcome && (outcome.status === 'failed' || outcome.status === 'cancelled')) {
        // Terminal segment state that did not throw: discard any continuation
        // registered just before termination so it cannot leak into a later
        // envelope (mirrors the guard in _finishInterruptedEnvelope).
        if (typeof this._agent.consumeContinuationRequest === 'function') {
          try { this._agent.consumeContinuationRequest(); } catch {}
        }
        envelope.status = outcome.status;
        envelope.error = outcome.error?.message || envelope.error || `call terminated: ${outcome.reason}`;
        return;
      }

      // ── Check for continuation request ──
      const continuation = typeof this._agent.consumeContinuationRequest === 'function'
        ? this._agent.consumeContinuationRequest()
        : null;

      if (!continuation) {
        // Normal completion — no continuation requested
        envelope.status = 'completed';
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
        if (this._finishInterruptedEnvelope(envelope)) return;
        this._injectContinuationSystemMessage('checkpoint', continuation);
        input = this._buildCheckpointContinuationInput(continuation);

      } else if (continuation.kind === 'rollback') {
        envelope._rollbackCount += 1;
        if (envelope._rollbackCount > this.continuationBudget.maxRollbacks) {
          throw new Error(`Continuation budget exhausted: maxRollbacks=${this.continuationBudget.maxRollbacks} reached for envelope ${envelope.id}`);
        }

        await this._rollbackBarrier(continuation, envelope);
        if (this._finishInterruptedEnvelope(envelope)) return;
        this._injectContinuationSystemMessage('rollback', continuation);
        input = this._buildRollbackContinuationInput(continuation);
      }
    }
  }

  _finishInterruptedEnvelope(envelope) {
    if (!envelope?._interruptRequested) return false;
    // A continuation may have been registered just before abort completed.
    // Consume and discard it so it cannot leak into a later envelope.
    if (typeof this._agent.consumeContinuationRequest === 'function') {
      try { this._agent.consumeContinuationRequest(); } catch {}
    }
    envelope.status = 'cancelled';
    envelope.error = envelope.error || 'cancelled by interrupt';
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
