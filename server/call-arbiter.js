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

    // ── Continuation support ──
    // Session save callback for checkpoint/rollback barriers.
    // Set via `arbiter.sessionSaveFn = async () => { ... }`.
    this.sessionSaveFn = null;

    // Continuation budget limits (per envelope).
    this.continuationBudget = {
      maxSegments: 20,
      maxCheckpoints: 5,
      maxRollbacks: 3,
    };

    // ── Supplement buffer ──
    // When the agent is busy (call active), queued-input messages go here
    // instead of becoming new envelopes. They are drained at each step start
    // and injected as system messages inside the current call.
    this._supplementBuffer = [];
  }

  /**
    * Enqueue a call envelope and kick the processing loop.
    *
    * @param {{ id?: string, source: string, sourceRef?: string, text: string, images?: Array<{base64?:string,mediaType?:string,source?:string}> }} envelope
    * @returns {object} The envelope with assigned id and status
    */
  enqueue(envelope) {
    // When agent is busy and this is a text-only queued-input (user supplement),
    // route to the supplement buffer instead of creating a new envelope.
    // The supplement will be injected as a system message inside the
    // current call at the next step start.
    //
    // IMPORTANT: inputs carrying images bypass the supplement path entirely.
    // Supplements are injected as system messages, which cannot carry image
    // content in any LLM API. Image inputs are substantive and need their own
    // onCall turn, so they queue as regular envelopes for execution after the
    // current call finishes.
    const hasImages = Array.isArray(envelope.images) && envelope.images.length > 0;
    if (this._active && envelope.source === 'queued-input' && !hasImages) {
      const supp = {
        text: envelope.text,
        sourceRef: envelope.sourceRef || '',
        timestamp: Date.now(),
      };
      this._supplementBuffer.push(supp);
      console.log(`[CallArbiter] supplemented (sourceRef=${supp.sourceRef}, buffer=${this._supplementBuffer.length})`);
      return {
        id: envelope.id || `supp-${Date.now()}`,
        source: envelope.source,
        sourceRef: supp.sourceRef,
        text: envelope.text,
        status: 'supplemented',
        createdAt: supp.timestamp,
      };
    }

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
   * Drain all pending supplements (called at each step start).
   * Also notifies the ViewerWorker to remove them from its queue display.
   * @returns {Array<{text: string, sourceRef: string}>} Drained supplements in order
   */
  drainSupplements() {
    if (this._supplementBuffer.length === 0) return [];
    const supplements = this._supplementBuffer.splice(0);
    const hub = getDebugHubInstance();
    if (hub && this._agent?.agentId) {
      for (const supp of supplements) {
        if (supp.sourceRef) {
          try {
            hub.consumeQueuedInput(this._agent.agentId, supp.sourceRef);
          } catch (error) {
            console.warn('[CallArbiter] consumeQueuedInput for supplement failed:', error);
          }
        }
      }
    }
    console.log(`[CallArbiter] drained ${supplements.length} supplement(s)`);
    return supplements;
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
    // Also clear pending supplements
    const clearedSupps = this._supplementBuffer.splice(0);
    this._status = this._active ? 'running' : 'idle';
    return removed.length + clearedSupps.length;
  }

  // -- Internal --

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

        // Convert leftover supplements to regular queued envelopes.
        // This happens when the call finishes before the next step could
        // drain them (e.g. agent completed at the current step).
        if (this._supplementBuffer.length > 0) {
          for (const supp of this._supplementBuffer) {
            this._queue.push({
              id: `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              source: 'queued-input',
              sourceRef: supp.sourceRef || '',
              text: supp.text,
              status: 'queued',
              createdAt: supp.timestamp || Date.now(),
              result: null,
              error: null,
            });
          }
          const count = this._supplementBuffer.length;
          this._supplementBuffer = [];
          console.log(`[CallArbiter] converted ${count} leftover supplement(s) to envelopes`);
        }

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
        // Continue draining the queue
        this._kick();
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
      // ── Budget enforcement ──
      envelope._segmentCount += 1;
      if (envelope._segmentCount > this.continuationBudget.maxSegments) {
        throw new Error(`Continuation budget exhausted: maxSegments=${this.continuationBudget.maxSegments} reached for envelope ${envelope.id}`);
      }

      // ── Execute one onCall segment ──
      const result = await this._agent.onCall(input, envelope.images);
      envelope.result = typeof result === 'string' ? result : '';

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
        this._injectContinuationSystemMessage('checkpoint', continuation);
        input = this._buildCheckpointContinuationInput(continuation);

      } else if (continuation.kind === 'rollback') {
        envelope._rollbackCount += 1;
        if (envelope._rollbackCount > this.continuationBudget.maxRollbacks) {
          throw new Error(`Continuation budget exhausted: maxRollbacks=${this.continuationBudget.maxRollbacks} reached for envelope ${envelope.id}`);
        }

        await this._rollbackBarrier(continuation, envelope);
        this._injectContinuationSystemMessage('rollback', continuation);
        input = this._buildRollbackContinuationInput(continuation);
      }
    }
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
